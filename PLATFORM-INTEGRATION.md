# Cross-platform accelerator ecosystem

## Portability
Use Node 22 or 24 on Windows, Linux or macOS. CPU JavaScript is the fallback;
the optional Node-API C++ addon is built for the host architecture. GPU uses
OpenCL 1.2+ where the vendor's ICD and compiler are installed. No CUDA, Metal,
Vulkan or ROCm-native backend is claimed. OpenCL is not guaranteed on Apple
Silicon or on every ARM Linux board. Use doctor before selecting hardware.

    npm ci
    npm run doctor
    npm run build:native
    node symbol10.cjs autotune input.s10
    node symbol10.cjs adaptive-unpack input.s10 restored.bin

The tuner samples bounded verified ranges near start, middle and end, and
compares warm CPU and every detected compatible OpenCL device. It estimates
full-archive time including startup. It is opt-in and not a utilization
controller; it does not benchmark disk writes or CPU worker configurations.
The chosen device is used for that operation. Errors from the CPU reference
are not suppressed. S10_OPENCL_LIBRARY can specify a trusted vendor loader.

## FPGA host ABI v1
Select an explicitly trusted CommonJS module with:
    node symbol10.cjs fpga-unpack archive.s10 restored.bin /path/to/driver.cjs

The module exports open(), returning {name,batchBlocks,decodeBatch,close}.
batchBlocks is 1..128. decodeBatch(jobs,output) is synchronous, returning
undefined or 0 on success. Jobs are {row,a,b,length,indices}; a,b are
resolved distinct 10-bit values; indices are packed LSB-first and length
is 1..65536. The output uses 65536-byte row strides, final row trimmed.
The driver must finish DMA before returning, write exactly the requested
row lengths, honor FPGA keep and last, report hardware errors, and not
retain JS pointers. Host verifies every block with existing SHA-256 before
publication. Unsupported palette widths, RAW and DEFLATE remain on CPU.
No driver module is downloaded or automatically executed.

Use the built-in CPU protocol simulator to verify integration:
    node symbol10.cjs fpga-unpack archive.s10 restored.bin simulator

This does not use physical FPGA hardware. To support a KU5P board, implement
the ABI in a native addon against the board's actual PCIe DMA driver, map
the job data onto the existing 64-bit input/512-bit output streaming RTL,
and implement reset, interrupt/polling, DMA bounds and error reporting.
Do not access arbitrary physical addresses or install unsigned drivers.
A vendor bitstream and PCIe driver are not included.

## Validation
The CI matrix includes Windows, Linux and macOS CPU/native tests; OpenCL
syntax and RTL simulation run on Linux. Hardware-specific throughput,
driver compatibility, FPGA timing and 5 GB/s at 25% resource usage require
physical devices and are not certified by CI.

## DMA record ABI

The optional packJob helper in fpga-packets.cjs packs each block into
16-byte little-endian records: 8 packed index bytes, a 32-bit control word
(A bits 0..9, B 10..19, output bytes 20..26, last 27), then four zero bytes.
The final record pads unused compressed bits with zeros. The helper supports
caller-owned staging buffers. hardware/s10_dma_stream.v accepts this exact
128-bit record, checks reserved fields, full input keep and matching TLAST,
and exposes the existing 512-bit output with keep/last. This is a framing
wrapper, not a PCIe endpoint, board driver or completed DMA implementation.

## Raspberry Pi 5 and portable CPU calibration

Use 64-bit Raspberry Pi OS (arm64). Install Node 22 or 24, Python 3, make
and a C++ compiler. Run npm ci, npm run build:native and npm run doctor.
The portable native encoder is opt-in via S10_ENABLE_NATIVE_ENCODE=1;
when absent or unavailable the existing JavaScript encoder remains active.
No architecture-specific instructions are required. Node's OpenSSL selects
available SHA-256 CPU instructions automatically when supported by the build.

    npm run bench:portable -- 1 0.5 3 32
    npm run bench:portable -- 4 0.5 3 32

Arguments: worker count, seconds per trial, rounds, 64 KiB blocks per worker.
Reports binary, text and random input, actual compressed payload ratio,
encoder, encoder+SHA, allocating decode, reusable binary decode, verified
decode and hash-only throughput, median/min/max, plus CPU identification.
Workers synchronize their start. Timing includes result delivery but not
fixture generation. File I/O and full archive metadata are excluded.
Clock model divisor = reported MHz * worker count / measured GB/s. Recalibrate
on each architecture; OS MHz is a snapshot, not a cycle counter. No Pi speed
is claimed until it is run there. CI includes an ARM64 Linux runner, not a Pi.

Full blocks restored by CPU workers now use caller-owned output slices directly for binary palette mode. Other codecs and partial ranges use the existing decode-and-copy fallback. Portable benchmark CPU usage is measured after the worker-ready barrier, including result delivery; it is process-wide, not a hard utilization cap.

## GPU resident 80 GB/s experiment

The opt-in coalesced binary decoder uses an 80-word local phase lookup table
and contiguous 32-bit output stores across work-items. The old tiled decoder
remains the default until physical benchmarks establish which is faster.
Both preserve the archive format and final-symbol validation. Run:

    npm run bench:gpu:resident -- 0 1024 15

This compares legacy, coalesced and vector4 kernels with a 64 MiB output working set and 15 repeated
resident dispatches. The device-event median excludes launch gaps; device-span
throughput includes gaps between GPU events; host-launch throughput includes
host enqueue and synchronization. Separate transfer-included and host SHA-256
rates are printed. All three GPU paths must match the CPU reference byte-for-byte.
Choose the faster strategy using S10_GPU_BINARY_KERNEL=coalesced, vector4 or legacy.
The resident batch size is separate from ordinary archive batch sizing, and
is bounded by allocation and device memory limits. No GPU utilization cap,
GPU-side SHA-256, or 80 GB/s physical result is claimed.

Vector4 obtains four phase keys from one guarded 32-bit compressed-input load and issues a 16-byte vector store. Actual memory transactions depend on the device compiler and must be measured.
