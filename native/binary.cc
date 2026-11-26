#include <node_api.h>
#include <array>
#include <cstdint>
#include <cstring>

namespace {
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
    const auto& cache=get_cache(a,b);
    const size_t full = length / 10;
    size_t i = 0;
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
    // Accumulate exactly eight indices and emit ten bytes in grouped stores.
    for(uint32_t group=0;group<length/10;group++){
        uint32_t v[8];
        for(unsigned j=0;j<8;j++){
            while(available<width){acc|=uint32_t(in[pos++])<<available;available+=8;}
            const uint32_t ix=acc&mask;acc>>=width;available-=width;
            if(ix>=k)return fail(env,"Invalid palette index");v[j]=values[ix];
        }
        const uint32_t a=v[0]|v[1]<<10|v[2]<<20|v[3]<<30;
        const uint32_t b=v[4]|v[5]<<10|v[6]<<20|v[7]<<30;
        // Explicit LE stores preserve format on big-endian hosts.
        for(unsigned j=0;j<4;j++){out[written+j]=uint8_t(a>>(8*j));out[written+5+j]=uint8_t(b>>(8*j));}
        out[written+4]=uint8_t(v[3]>>2);out[written+9]=uint8_t(v[7]>>2);written+=10;
    }
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
napi_value init(napi_env env, napi_value exports) {
    napi_value fn;
    if (napi_create_function(env, "expand", NAPI_AUTO_LENGTH, expand, nullptr, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "expand", fn) != napi_ok ||
        napi_set_named_property(env, exports, "expandInto", fn) != napi_ok) return fail(env, "Cannot initialize addon");
    if(napi_create_function(env,"expandPalette",NAPI_AUTO_LENGTH,expand_palette,nullptr,&fn)!=napi_ok||
       napi_set_named_property(env,exports,"expandPalette",fn)!=napi_ok)return fail(env,"Cannot initialize palette addon");
    return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
