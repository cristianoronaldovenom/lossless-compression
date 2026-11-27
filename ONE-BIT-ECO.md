# One-bit symbol fast path (experimental)

A binary palette has exactly two original 10-bit values. Each index is stored
as one bit (0 or 1). Eight indices reconstruct ten bytes. A one-value palette
needs zero index bits. This is not a way to represent 1,024 arbitrary values
with a single bit: the encoder must fall back to wider palettes or raw data.
The v1 archive remains compatible with existing readers. V2's palette codec
also uses the CPU fast path. V3/Bitline recovery archives are not changed.

For a full 65,536-byte binary block, the stored palette payload is 6,560 bytes
(6-byte header and 6,554 index bytes), plus archive metadata: about 9.99x.
This is specific to data with two distinct 10-bit values.

## Build and run (Windows PowerShell)

Node.js is required. The JavaScript path works without a compiler. Optional
native Node-API addon: install Visual Studio Build Tools (Desktop development
with C++) and Python as required by node-gyp. Run from the project root:

    npm install
    npx node-gyp rebuild --directory native
    node --test test/binary-palette.test.cjs
    node tools/bench-binary.cjs 5

Compare JavaScript and original generic paths:

    $env:S10_DISABLE_NATIVE = "1"
    node tools/bench-binary.cjs 5
    $env:S10_DISABLE_BINARY_FAST = "1"
    node tools/bench-binary.cjs 5
    Remove-Item Env:S10_DISABLE_NATIVE, Env:S10_DISABLE_BINARY_FAST

Use the existing v1 CLI (not the v3 launcher):

    node symbol10.cjs pack input.bin input.s10 --fast-decode --workers=eco
    node symbol10.cjs unpack input.s10 restored.bin --workers=eco
    node symbol10.cjs bench-decode input.s10 --gpu=auto --gpu-pipeline --seconds=10

The eco worker setting picks floor(available logical CPUs / 4), clamped to
1–16. This is a concurrency limit, not a hard CPU utilization cap. GPU mode
uses the existing OpenCL pipeline and the new one-bit kernel. It reports
kernel and verified wall-clock throughput separately. On NVIDIA, monitor in a
second terminal with:

    nvidia-smi --query-gpu=utilization.gpu,utilization.memory,power.draw --format=csv -lms 200

GPU utilization is device-wide sampled busy time, not an allocated fraction
of cores. 5 GB/s verified throughput at <=25% CPU and GPU utilization is an
unverified target, not a promise. No GPU cap is implemented. Verify original
and restored SHA-256 hashes, report measured resource usage, and test real
files; synthetic one-bit data is intentionally favorable. Disk and PCIe can
limit throughput. The native addon accelerates only binary palettes. Other
codecs and existing checksum, recovery, and publication rules are unchanged.

## Binary-first architecture and hardware

See [exact architecture and equations](SYMBOL-MATH-ARCHITECTURE.md). Run `node --test test/binary-encode.test.cjs` and `node tools/symbol-math.cjs 65536 2`. Set `S10_DISABLE_BINARY_ENCODE=1` to compare the previous encoder.
