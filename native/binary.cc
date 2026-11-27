#include <node_api.h>
#include <array>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include "cpu-expand.h"

namespace {
thread_local unsigned selected_kernel=0;
struct Cache {
    uint32_t key = 0xffffffffu;
    std::array<std::array<uint8_t, 10>, 256> entries{};
    void prepare(uint32_t a, uint32_t b) {
        const uint32_t k = (a << 10) | b;
        if (key == k) return;
        for (unsigned i = 0; i < 256; ++i) {
            uint32_t bits = 0, available = 0, out = 0;
            for (unsigned s = 0; s < 8; ++s) {
                bits |= ((i >> s) & 1 ? b : a) << available;
                available += 10;
                while (available >= 8) {
                    entries[i][out++] = static_cast<uint8_t>(bits);
                    bits >>= 8; available -= 8;
                }
            }
        }
        key = k;
    }
};
thread_local std::array<Cache,4> caches;
thread_local unsigned next_cache=0;
Cache& get_cache(uint32_t a,uint32_t b){
    const uint32_t key=(a<<10)|b;
    for(auto& c:caches)if(c.key==key)return c;
    auto& c=caches[next_cache++&3];c.prepare(a,b);return c;
}
napi_value fail(napi_env env, const char* message) {
    napi_throw_error(env, nullptr, message);
    return nullptr;
}
napi_value expand(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value args[5], result, backing;
    uint32_t length, a, b;
    napi_typedarray_type type;
    size_t input_size, byte_offset;
    void* source = nullptr;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || (argc != 4 && argc != 5) ||
        napi_get_typedarray_info(env, args[0], &type, &input_size, &source, &backing, &byte_offset) != napi_ok ||
        type != napi_uint8_array ||
        napi_get_value_uint32(env, args[1], &length) != napi_ok ||
        napi_get_value_uint32(env, args[2], &a) != napi_ok ||
        napi_get_value_uint32(env, args[3], &b) != napi_ok ||
        length == 0 || length > 65536 || a > 1023 || b > 1023 || a == b)
        return fail(env, "Invalid binary palette arguments");
    const uint32_t count = (length * 8 + 9) / 10;
    if (input_size != (count + 7) / 8 || !source) return fail(env, "Invalid binary index length");
    const auto* input = static_cast<const uint8_t*>(source);
    if ((count & 7) && (input[input_size-1] >> (count & 7))) return fail(env, "Invalid index padding");
    const uint32_t last = ((input[(count-1)/8] >> ((count-1)%8)) & 1) ? b : a;
    if (last >> (length*8 - 10*(count-1))) return fail(env, "Invalid symbol padding");
    void* dest = nullptr;
    if (argc==5) {
        napi_typedarray_type out_type; size_t out_size,out_offset; napi_value out_backing;
        if(napi_get_typedarray_info(env,args[4],&out_type,&out_size,&dest,&out_backing,&out_offset)!=napi_ok||
            out_type!=napi_uint8_array||out_size!=length||!dest)return fail(env,"Invalid output");
        const auto in_addr=reinterpret_cast<uintptr_t>(source),out_addr=reinterpret_cast<uintptr_t>(dest);
        if((out_addr>=in_addr&&out_addr-in_addr<input_size)||(in_addr>=out_addr&&in_addr-out_addr<length))
            return fail(env,"Overlapping output");
        result=args[4];
    } else if (napi_create_buffer(env, length, &dest, &result) != napi_ok) return fail(env, "Cannot allocate output");
    auto* out = static_cast<uint8_t*>(dest);
    const size_t full = length / 10;
    size_t i = 0;
    // Opt-in or automatic CPU ISA selection. No AVX instruction executes
    // on an unsupported CPU. Scalar remains a reference and fallback.
    static const bool avx=s10cpu::has_avx2(),bmi=s10cpu::has_bmi2();
#if S10_X86_TARGET
    if((selected_kernel==0||selected_kernel==2)&&avx)
        i=s10cpu::avx2(input,out,full,a,b);
    else if(selected_kernel==3&&bmi)
        i=s10cpu::bmi2(input,out,full,a,b);
#endif
    if(i==full&&length%10==0)return result;
    // SIMD handles complete 20-byte units; a bounded scalar tail avoids
    // preparing the large lookup table for changing palettes.
    if(i!=0){
        for(size_t j=i;j<(length+9)/10;j++){
            uint8_t tmp[10]={};uint32_t bits=0,available=0,written=0;
            for(unsigned s=0;s<8;s++){
                bits|=((input[j]>>s)&1?b:a)<<available;available+=10;
                while(available>=8){tmp[written++]=uint8_t(bits);bits>>=8;available-=8;}
            }
            const size_t n=length-j*10<10?length-j*10:10;
            std::memcpy(out+j*10,tmp,n);
        }
        return result;
    }
    const auto& cache=get_cache(a,b);
    for (; i + 4 <= full; i += 4) {
        std::memcpy(out + 10*i, cache.entries[input[i]].data(), 10);
        std::memcpy(out + 10*i + 10, cache.entries[input[i+1]].data(), 10);
        std::memcpy(out + 10*i + 20, cache.entries[input[i+2]].data(), 10);
        std::memcpy(out + 10*i + 30, cache.entries[input[i+3]].data(), 10);
    }
    for (; i < full; ++i) std::memcpy(out + 10*i, cache.entries[input[i]].data(), 10);
    if (length % 10) std::memcpy(out + 10*full, cache.entries[input[full]].data(), length % 10);
    return result;
}
template<unsigned W>
bool wide_tiles(const uint8_t* in,uint8_t* out,const uint16_t* values,size_t k,size_t groups){
    constexpr uint32_t mask=(1u<<W)-1;
    for(size_t i=0;i<groups;i++,in+=W,out+=10){
        uint64_t packed=0;
        for(unsigned j=0;j<(W<9?W:8);j++)packed|=uint64_t(in[j])<<(8*j);
        const uint64_t second=(packed>>(4*W))|(W==9?uint64_t(in[8])<<28:0);
        const uint32_t a=packed&mask,b=(packed>>W)&mask,c=(packed>>(2*W))&mask,d=(packed>>(3*W))&mask;
        const uint32_t e=second&mask,f=(second>>W)&mask,g=(second>>(2*W))&mask,h=(second>>(3*W))&mask;
        if(a>=k||b>=k||c>=k||d>=k||e>=k||f>=k||g>=k||h>=k)return false;
        const uint32_t x=values[a]|uint32_t(values[b])<<10|uint32_t(values[c])<<20|uint32_t(values[d])<<30;
        const uint32_t y=values[e]|uint32_t(values[f])<<10|uint32_t(values[g])<<20|uint32_t(values[h])<<30;
        for(unsigned j=0;j<4;j++){out[j]=uint8_t(x>>(8*j));out[5+j]=uint8_t(y>>(8*j));}
        out[4]=uint8_t(values[d]>>2);out[9]=uint8_t(values[h]>>2);
    }
    return true;
}
napi_value expand_palette(napi_env env, napi_callback_info info) {
    size_t argc=4; napi_value args[4],backing,result;
    napi_typedarray_type type; size_t n,off,k; void* source=nullptr; void* palette=nullptr;
    uint32_t length,width;
    if(napi_get_cb_info(env,info,&argc,args,nullptr,nullptr)!=napi_ok||argc!=4||
       napi_get_typedarray_info(env,args[0],&type,&n,&source,&backing,&off)!=napi_ok||type!=napi_uint8_array||
       napi_get_value_uint32(env,args[1],&length)!=napi_ok||
       napi_get_value_uint32(env,args[2],&width)!=napi_ok||
       napi_get_typedarray_info(env,args[3],&type,&k,&palette,&backing,&off)!=napi_ok||type!=napi_uint16_array||
       length<1||length>65536||width<2||width>9||k<3||k>(1u<<width)||k<=(1u<<(width-1)))
        return fail(env,"Invalid native palette");
    const uint32_t count=(length*8+9)/10, bits=count*width;
    if(n!=(bits+7)/8||!source||!palette)return fail(env,"Invalid native palette length");
    const auto* in=static_cast<const uint8_t*>(source);
    const auto* values=static_cast<const uint16_t*>(palette);
    if((bits&7)&&(in[n-1]>>(bits&7)))return fail(env,"Invalid index padding");
    for(size_t i=0;i<k;i++)if(values[i]>1023)return fail(env,"Invalid palette value");
    void* dest=nullptr;
    if(napi_create_buffer(env,length,&dest,&result)!=napi_ok)return fail(env,"Cannot allocate output");
    auto* out=static_cast<uint8_t*>(dest);
    uint32_t acc=0,available=0,output=0,used=0; size_t pos=0,written=0;
    const uint32_t mask=(1u<<width)-1;
    const size_t groups=length/10;
    bool ok=false;
    switch(width){
        case 2:ok=wide_tiles<2>(in,out,values,k,groups);break;
        case 3:ok=wide_tiles<3>(in,out,values,k,groups);break;
        case 4:ok=wide_tiles<4>(in,out,values,k,groups);break;
        case 5:ok=wide_tiles<5>(in,out,values,k,groups);break;
        case 6:ok=wide_tiles<6>(in,out,values,k,groups);break;
        case 7:ok=wide_tiles<7>(in,out,values,k,groups);break;
        case 8:ok=wide_tiles<8>(in,out,values,k,groups);break;
        case 9:ok=wide_tiles<9>(in,out,values,k,groups);break;
    }
    if(!ok)return fail(env,"Invalid palette index");
    pos=groups*width;written=groups*10;
    for(uint32_t j=(length/10)*8;j<count;j++){
        while(available<width){acc|=uint32_t(in[pos++])<<available;available+=8;}
        const uint32_t ix=acc&mask;acc>>=width;available-=width;
        if(ix>=k)return fail(env,"Invalid palette index");
        output|=uint32_t(values[ix])<<used;used+=10;
        while(used>=8&&written<length){out[written++]=uint8_t(output);output>>=8;used-=8;}
    }
    if(written!=length||output)return fail(env,"Invalid symbol padding");
    return result;
}
// Portable packed encoder. No unaligned pointer casts or ISA requirements.
// Four 10-bit symbols are read from exactly five bytes.
napi_value encode_binary(napi_env env,napi_callback_info info){
    size_t argc=2,n,k,offset; napi_value args[2],backing,result;
    napi_typedarray_type type; void* source=nullptr;void* dictionary=nullptr;
    if(napi_get_cb_info(env,info,&argc,args,nullptr,nullptr)!=napi_ok||argc!=2||
       napi_get_typedarray_info(env,args[0],&type,&n,&source,&backing,&offset)!=napi_ok||type!=napi_uint8_array||
       napi_get_typedarray_info(env,args[1],&type,&k,&dictionary,&backing,&offset)!=napi_ok||type!=napi_uint16_array||k!=1024)
        return fail(env,"Invalid native encoder arguments");
    napi_get_null(env,&result);
    if(n<16||n>65536||!source||!dictionary)return result;
    const auto* raw=static_cast<const uint8_t*>(source);
    const auto* forward=static_cast<const uint16_t*>(dictionary);
    const uint32_t a=(uint32_t(raw[0])|uint32_t(raw[1])<<8)&1023;
    uint32_t b=1024;
    const size_t count=(n*8+9)/10,groups=n/5;
    std::array<uint8_t,6560> packed{};
    auto classify=[&](uint32_t v,unsigned j,uint8_t& mask){
        if(v==a)return true;
        if(b==1024)b=v;
        if(v!=b)return false;
        mask|=uint8_t(1u<<j);return true;
    };
    size_t i=0;
    const uint64_t base=uint64_t(a)*0x40100401ULL;
    for(;i<groups;i++){
        const uint64_t word=s10cpu::read40(raw+i*5);
        if(word==base)continue;
        uint8_t mask=0;
        for(unsigned j=0;j<4;j++)if(!classify(uint32_t(word>>(10*j))&1023,j,mask))return result;
        packed[6+i/2]|=uint8_t(mask<<((i&1)*4));
        ++i;break;
    }
    if(b!=1024){
        bool ok;
#if S10_X86_TARGET
        static const bool bmi=s10cpu::has_bmi2();
        if(bmi&&selected_kernel!=1)ok=s10cpu::pack_bmi2(raw,packed.data()+6,i,groups,a,b);
        else
#endif
        ok=s10cpu::pack_scalar(raw,packed.data()+6,i,groups,a,b);
        if(!ok)return result;
    }
    if(n%5){
        uint32_t low=0;for(size_t j=0;j<n%5;j++)low|=uint32_t(raw[groups*5+j])<<(j*8);
        uint8_t mask=0;
        for(unsigned j=0;j<(n%5*8+9)/10;j++)if(!classify((low>>(10*j))&1023,j,mask))return result;
        packed[6+groups/2]|=uint8_t(mask<<((groups&1)*4));
    }
    const size_t bytes=b==1024?4:6+(count+7)/8;
    if(bytes>=n)return result;
    const uint32_t sa=forward[a];if(sa>=1024)return fail(env,"Invalid dictionary entry");
    packed[0]=b==1024?1:2;packed[2]=uint8_t(sa);packed[3]=uint8_t(sa>>8);
    if(b!=1024){const uint32_t sb=forward[b];if(sb>=1024||sa==sb)return fail(env,"Invalid dictionary entry");
        packed[4]=uint8_t(sb);packed[5]=uint8_t(sb>>8);}
    if(napi_create_buffer_copy(env,bytes,packed.data(),nullptr,&result)!=napi_ok)return fail(env,"Cannot allocate encoded output");
    return result;
}
napi_value select_cpu_kernel(napi_env env,napi_callback_info info){
    size_t argc=1;napi_value arg,result;uint32_t mode=0;
    if(napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr)!=napi_ok||argc!=1||
       napi_get_value_uint32(env,arg,&mode)!=napi_ok||mode>3)return fail(env,"Invalid CPU kernel");
    selected_kernel=mode;napi_get_undefined(env,&result);return result;
}
napi_value cpu_capabilities(napi_env env,napi_callback_info){
    napi_value result,value;napi_create_object(env,&result);
    napi_get_boolean(env,s10cpu::has_avx2(),&value);napi_set_named_property(env,result,"avx2",value);
    napi_get_boolean(env,s10cpu::has_bmi2(),&value);napi_set_named_property(env,result,"bmi2",value);
    return result;
}
napi_value init(napi_env env, napi_value exports) {
    napi_value fn;
    if (napi_create_function(env, "expand", NAPI_AUTO_LENGTH, expand, nullptr, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "expand", fn) != napi_ok ||
        napi_set_named_property(env, exports, "expandInto", fn) != napi_ok) return fail(env, "Cannot initialize addon");
    if(napi_create_function(env,"expandPalette",NAPI_AUTO_LENGTH,expand_palette,nullptr,&fn)!=napi_ok||
       napi_set_named_property(env,exports,"expandPalette",fn)!=napi_ok)return fail(env,"Cannot initialize palette addon");
    if(napi_create_function(env,"encodeBinary",NAPI_AUTO_LENGTH,encode_binary,nullptr,&fn)!=napi_ok||
       napi_set_named_property(env,exports,"encodeBinary",fn)!=napi_ok)return fail(env,"Cannot initialize native encoder");
    if(napi_create_function(env,"cpuCapabilities",NAPI_AUTO_LENGTH,cpu_capabilities,nullptr,&fn)!=napi_ok||
       napi_set_named_property(env,exports,"cpuCapabilities",fn)!=napi_ok)return fail(env,"Cannot initialize CPU capabilities");
    if(napi_create_function(env,"selectCpuKernel",NAPI_AUTO_LENGTH,select_cpu_kernel,nullptr,&fn)!=napi_ok||
       napi_set_named_property(env,exports,"selectCpuKernel",fn)!=napi_ok)return fail(env,"Cannot initialize CPU selection");
    return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
