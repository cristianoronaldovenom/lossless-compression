// A work-group shares one decoded palette across approximately 4 KiB of adjacent output.
__kernel void expand(__global const uchar *bytes, __global const uint *jobs,
                     __global const ushort *inverse, __global uint *out) {
    uint row = get_global_id(1);
    __global const uint *job = jobs + DESCRIPTOR_WORDS * row;
    uint width = job[3], size = job[4], lane = get_local_id(0);
    uint lanes = get_local_size(0);
    uint count = (size * 8 + 9) / 10;
    uint words = (size + 3) / 4;
    uint first = get_group_id(0) * WORDS_PER_GROUP;
    if (first >= words) return;
    uint limit = min(first + WORDS_PER_GROUP, words);
    volatile __global int *error = (volatile __global int *)out;
    __global uint *target = out + HEADER_WORDS + row * CHUNK_WORDS;

    // A single-entry palette has no index stream.
    if (width == 0) {
        uint offset = job[0];
        uint id = (uint)bytes[offset] | ((uint)bytes[offset + 1] << 8);
        if (id >= SYMBOL_COUNT) {
            if (get_global_id(0) == 0) atomic_or(error, 1);
            return;
        }
        uint value = inverse[id];
        if (get_global_id(0) == 0 && value >> (size * 8 - 10 * (count - 1))) atomic_or(error, 2);
        for (uint word = first + lane; word < limit; word += lanes) {
            uint skip = (word % 5) * 2;
            target[word] = (value >> skip) | (value << (10 - skip)) |
                (value << (20 - skip)) | (value << (30 - skip));
        }
        return;
    }

    uint mask = (1u << width) - 1;
    __local ushort palette[SYMBOL_COUNT];
    for (uint i = lane; i <= mask; i += lanes) {
        ushort value = 0x8000;
        if (i < job[2]) {
            uint offset = job[0] + i * 2;
            uint id = (uint)bytes[offset] | ((uint)bytes[offset + 1] << 8);
            if (id < SYMBOL_COUNT) value = inverse[id];
            else atomic_or(error, 1);
        }
        palette[i] = value;
    }
    barrier(CLK_LOCAL_MEM_FENCE);

    // Four-bit indices: unpack 16 symbols into five output words, loading
    // each index once. The generic loop handles the final partial unit.
    uint genericFirst = first;
    if (width == 4) {
        uint fullLimit = min(limit / 5, size / 20) * 5;
        for (uint word = first + 5 * lane; word < fullLimit; word += 5 * lanes) {
            __global const uchar *in = bytes + job[1] + (word / 5) * 8;
            uint lo = as_uint(vload4(0, in)), hi = as_uint(vload4(0, in + 4));
            uint a = palette[lo & 15], b = palette[(lo >> 4) & 15], c = palette[(lo >> 8) & 15], d = palette[(lo >> 12) & 15];
            uint e = palette[(lo >> 16) & 15], f = palette[(lo >> 20) & 15], g = palette[(lo >> 24) & 15], h = palette[lo >> 28];
            uint i = palette[hi & 15], j = palette[(hi >> 4) & 15], k = palette[(hi >> 8) & 15], l = palette[(hi >> 12) & 15];
            uint m = palette[(hi >> 16) & 15], n = palette[(hi >> 20) & 15], o = palette[(hi >> 24) & 15], p = palette[hi >> 28];
            if ((a | b | c | d | e | f | g | h | i | j | k | l | m | n | o | p) & 0x8000) atomic_or(error, 1);
            vstore4((uint4)(a | (b << 10) | (c << 20) | (d << 30),
                (d >> 2) | (e << 8) | (f << 18) | (g << 28),
                (g >> 4) | (h << 6) | (i << 16) | (j << 26),
                (j >> 6) | (k << 4) | (l << 14) | (m << 24)), 0, target + word);
            target[word + 4] = (m >> 8) | (n << 2) | (o << 12) | (p << 22);
        }
        genericFirst = max(first, fullLimit);
    }
    for (uint word = genericFirst + lane; word < limit; word += lanes) {
        uint symbol = word * 32 / 10;
        uint skip = (word % 5) * 2;
        uint bit = symbol * width;
        __global const uchar *indices = bytes + job[1];
        uint low = as_uint(vload4(0, indices + (bit >> 3))) >> (bit & 7);
        uint high;
        if (width <= 6) high = low >> (2 * width);
        else {
            uint next = bit + 2 * width;
            high = as_uint(vload4(0, indices + (next >> 3))) >> (next & 7);
        }
        uint a = palette[low & mask];
        uint b = palette[(low >> width) & mask];
        uint c = palette[high & mask];
        uint d = palette[(high >> width) & mask];
        if (word + 1 == words) {
            uint remaining = count - symbol;
            if (remaining <= 3) d = 0;
            if (remaining <= 2) c = 0;
            if (remaining == 1) b = 0;
            uint last = remaining == 1 ? a : remaining == 2 ? b : remaining == 3 ? c : d;
            uint valid = size * 8 - 10 * (count - 1);
            if (last >> valid) atomic_or(error, 2);
        }
        if ((a | b | c | d) & 0x8000) atomic_or(error, 1);
        target[word] = (a >> skip) | (b << (10 - skip)) | (c << (20 - skip)) | (d << (30 - skip));
    }
}
