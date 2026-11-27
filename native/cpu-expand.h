#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#if (defined(__x86_64__) || defined(_M_X64)) && (defined(__GNUC__) || defined(__clang__) || defined(_MSC_VER))
#include <immintrin.h>
#define S10_X86_TARGET 1
#if defined(_MSC_VER)
#include <intrin.h>
#define S10_TARGET(isa) __declspec(noinline)
#else
#define S10_TARGET(isa) __attribute__((target(isa),noinline))
#endif
#else
#define S10_X86_TARGET 0
#endif
namespace s10cpu {
inline uint64_t read40(const uint8_t* p){
 return uint64_t(p[0])|uint64_t(p[1])<<8|uint64_t(p[2])<<16|uint64_t(p[3])<<24|uint64_t(p[4])<<32;
}
inline unsigned distinguishing_bit(uint32_t a,uint32_t b){
 unsigned pick=0;uint32_t d=a^b;while(d&&!(d&1)){d>>=1;++pick;}return pick;
}
inline bool pack_scalar(const uint8_t* raw,uint8_t* packed,size_t start,size_t groups,uint32_t a,uint32_t b){
 constexpr uint64_t mask=0x40100401ULL;const uint64_t base=uint64_t(a)*mask,delta=a^b;
 const unsigned pick=distinguishing_bit(a,b);
 uint64_t table[16];for(unsigned m=0;m<16;m++)table[m]=(uint64_t(m&1)|uint64_t(m&2)<<9|uint64_t(m&4)<<18|uint64_t(m&8)<<27)*delta;
 for(size_t i=start;i<groups;i++){
  const uint64_t x=read40(raw+5*i)^base,y=x>>pick;
  const unsigned m=unsigned((y&1)|((y>>9)&2)|((y>>18)&4)|((y>>27)&8));
  if(x!=table[m])return false;
  packed[i/2]|=uint8_t(m<<((i&1)*4));
 }
 return true;
}
inline bool has_bmi2(){
#if S10_X86_TARGET && defined(_MSC_VER)
 int r[4];__cpuid(r,0);if(r[0]<7)return false;__cpuidex(r,7,0);return (r[1]&(1<<8))!=0;
#elif S10_X86_TARGET
 return __builtin_cpu_supports("bmi2");
#else
 return false;
#endif
}
inline bool has_avx2(){
#if S10_X86_TARGET && defined(_MSC_VER)
 int r[4];__cpuid(r,0);if(r[0]<7)return false;__cpuid(r,1);
 if((r[2]&0x18000000)!=0x18000000||(_xgetbv(0)&6)!=6)return false;
 __cpuidex(r,7,0);return (r[1]&(1<<5))!=0;
#elif S10_X86_TARGET
 return __builtin_cpu_supports("avx2");
#else
 return false;
#endif
}
#if S10_X86_TARGET
S10_TARGET("bmi2") inline bool pack_bmi2(const uint8_t* raw,uint8_t* packed,size_t start,size_t groups,uint32_t a,uint32_t b){
 constexpr uint64_t mask=0x40100401ULL;const uint64_t base=uint64_t(a)*mask,delta=a^b;
 const unsigned pick=distinguishing_bit(a,b);const uint64_t selector=mask<<pick;
 uint64_t table[16];for(unsigned m=0;m<16;m++)table[m]=_pdep_u64(m,mask)*delta;
 for(size_t i=start;i<groups;i++){
  const uint64_t x=read40(raw+5*i)^base;const unsigned m=unsigned(_pext_u64(x,selector));
  if(x!=table[m])return false;
  packed[i/2]|=uint8_t(m<<((i&1)*4));
 }
 return true;
}
S10_TARGET("bmi2") inline size_t bmi2(const uint8_t* in,uint8_t* out,size_t full,uint32_t a,uint32_t b){
 constexpr uint64_t mask=0x40100401ULL;
 const uint64_t base=uint64_t(a)*mask,delta=a^b;
 size_t i=0;
 for(;i+2<=full;i+=2){
  const unsigned x=in[i]|unsigned(in[i+1])<<8;
  const uint64_t p=base^(_pdep_u64(x,mask)*delta),q=base^(_pdep_u64(x>>4,mask)*delta);
  const uint64_t r=base^(_pdep_u64(x>>8,mask)*delta),s=base^(_pdep_u64(x>>12,mask)*delta);
  const uint64_t lo=p|(q<<40),hi=(q>>24)|(r<<16)|(s<<56);
  const uint32_t tail=uint32_t(s>>8);
  std::memcpy(out+i*10,&lo,8);std::memcpy(out+i*10+8,&hi,8);std::memcpy(out+i*10+16,&tail,4);
 }
 return i;
}
S10_TARGET("avx2") inline size_t avx2(const uint8_t* in,uint8_t* out,size_t full,uint32_t a,uint32_t b){
 const __m256i shifts=_mm256_setr_epi64x(0,4,8,12),nibble=_mm256_set1_epi64x(15),spread=_mm256_set1_epi64x(0x08040201),mask=_mm256_set1_epi64x(0x40100401);
 const __m256i base=_mm256_set1_epi64x(uint64_t(a)*0x40100401ULL),delta=_mm256_set1_epi64x(a^b);
 const __m256i shuffle=_mm256_setr_epi8(0,1,2,3,4,8,9,10,11,12,-1,-1,-1,-1,-1,-1,0,1,2,3,4,8,9,10,11,12,-1,-1,-1,-1,-1,-1);
 size_t i=0;
 for(;i+2<=full;i+=2){
  const unsigned x=in[i]|unsigned(in[i+1])<<8;
  const __m256i bits=_mm256_and_si256(_mm256_srlv_epi64(_mm256_set1_epi64x(x),shifts),nibble);
  const __m256i expanded=_mm256_and_si256(_mm256_mul_epu32(bits,spread),mask);
  const __m256i values=_mm256_xor_si256(base,_mm256_mul_epu32(expanded,delta));
  const __m256i packed=_mm256_shuffle_epi8(values,shuffle);
  const __m128i l=_mm256_castsi256_si128(packed),h=_mm256_extracti128_si256(packed,1);
  _mm_storeu_si128(reinterpret_cast<__m128i*>(out+i*10),_mm_or_si128(l,_mm_slli_si128(h,10)));
  const uint32_t tail=uint32_t(_mm_cvtsi128_si32(_mm_srli_si128(h,6)));
  std::memcpy(out+i*10+16,&tail,4);
 }
 return i;
}
#endif
}
