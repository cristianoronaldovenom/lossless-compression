# GPU + FPGA streaming acceleration (experimental)
## GPU
The one-bit OpenCL kernel now expands 16 symbols from two input bytes into
five 32-bit output words. It uses four 40-bit nibble LUT entries, a vector
write and a final word write. Full tiles contain no per-symbol bounds branch.
Partial tiles use a separate bounded path with exact original padding checks.
The existing CPU archive framing, digest and palette validation remain.
Two independent OpenCL queues and two sets of device buffers can be used
with --gpu-pipeline. Uploads and downloads remain blocking on the host to
avoid undocumented JS pointer lifetime assumptions; independent queues let
the next kernel or transfer overlap the previous one if the driver supports
it. No promise of copy-engine overlap or 25% utilization. Set S10_GPU_SLOTS=1
to use a single queue for comparison. Maximum device buffers are roughly
32 MiB on discrete GPUs, 8 MiB on integrated GPUs, excluding driver overhead.
Run node symbol10.cjs self-test --gpu and bench-decode on the same archive
with/without --gpu-pipeline. GPU results must be verified and separately
report kernel speed and end-to-end speed.

## FPGA
hardware/s10_binary_stream.v is a platform-neutral synchronous streaming
core, not a PCIe bitstream. 64 input bits expand to 80 bytes via 64 10-bit
multiplexers. A registered 640-bit stage feeds a 144-byte gearbox with
fixed 16-byte-aligned offsets. The 512-bit output can emit 64 bytes every
clock when downstream is ready. The input has ready/valid and an explicit
decoded-byte count; each nonfinal beat must decode 80 bytes, the final
beat 1..80. Output keep marks valid bytes and last marks block end.
The caller supplies the two resolved values (must differ), validates
archive framing and digest, and resets on sticky error. The core is
binary-palette only. Data is not publishable until integrity checks pass.
At 125 MHz the ideal output-bus capacity is 8 GB/s; at 200 MHz it is
12.8 GB/s. Finite blocks, framing, backpressure and PCIe reduce this.
A 64 KiB binary block uses 820 input beats, 1024 output beats, and a
few fill/drain cycles. Sustaining 5 GB/s on a 125 MHz bus requires at
least 62.5% useful output utilization. A 25% FPGA duty target would
instead require >=20 GB/s full-load output capacity.
For a KU5P board use a vendor-supported PCIe Gen3 x8 DMA design, clock
domain crossing if needed, AXI-stream wrapper, descriptor validation,
checksum verification, host driver and test harness. Board documentation,
pin assignments and implementation timing are required.
Simulation: iverilog -g2012 -s tb_s10_binary_stream -o sim hardware/s10_binary_stream.v hardware/tb_s10_binary_stream.sv
then vvp sim. No physical FPGA synthesis or GPU execution has been done
in this environment. Test the RTL in simulation and perform timing closure.
CPU and GPU formats are unchanged; FPGA does not yet restore full archives.

## Continuous pipeline and memory reuse

The ordered pipeline retains two queued device jobs and a third host scratch
buffer, refilling before verification while retaining completed input.
CPU-only blocks run after GPU dispatch. Checksums remain mandatory.
Set S10_GPU_BATCH_BLOCKS to 1..128 to tune batch size; integrated GPUs are
capped at 32. Kernel time is summed, not busy wall time. The packed encoder
uses one distinguishing bit and an exact 40-bit XOR table. Set
S10_BINARY_REFERENCE=1 to compare the previous encoder. The in-memory
expandBinaryInto API accepts a nonoverlapping preallocated Uint8Array; the
optional native addon supports it and caches four palettes per thread.
File restoration still uses the existing archive output API. FPGA packet
validation checks dictionary consistency and 64 KiB bounds; reset and discard
on error. No PCIe driver or synthesis is supplied. Run
node --test test/performance-core.test.cjs and node tools/bench-performance.cjs 1 5
for paired memory benchmarks. These are not full restore benchmarks.
