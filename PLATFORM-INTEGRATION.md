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
