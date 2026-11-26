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
thread_local Cache cache;
napi_value fail(napi_env env, const char* message) {
    napi_throw_error(env, nullptr, message);
    return nullptr;
}
napi_value expand(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value args[4], result, backing;
    uint32_t length, a, b;
    napi_typedarray_type type;
    size_t input_size, byte_offset;
    void* source = nullptr;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 4 ||
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
    if (napi_create_buffer(env, length, &dest, &result) != napi_ok) return fail(env, "Cannot allocate output");
    auto* out = static_cast<uint8_t*>(dest);
    cache.prepare(a,b);
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
napi_value init(napi_env env, napi_value exports) {
    napi_value fn;
    if (napi_create_function(env, "expand", NAPI_AUTO_LENGTH, expand, nullptr, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "expand", fn) != napi_ok) return fail(env, "Cannot initialize addon");
    return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
