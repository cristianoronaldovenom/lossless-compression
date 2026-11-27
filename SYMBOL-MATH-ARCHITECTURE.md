# Symbol10 exact architecture: binary-first, memory-streaming

## Exact coding
For original byte length L, N=ceil(8L/10) symbols. Symbol j is the ten
bits at bit offset 10j, interpreted little endian, with only the final
symbol zero-padded. For K distinct symbols, w=ceil(log2 K), w=0 when K=1.
The current palette payload is P=2+2K+ceil(Nw/8) bytes. V1 archive size
is exactly 72+sum(32+stored block bytes). Raw fallback uses L bytes.
For K=2, P=6+ceil(L/10). At L=65536: N=52429, P=6560, one-block archive
=6664 bytes. The maximum ratio tends to 10 for binary palettes, before
metadata. K=1 is a separate zero-bit repeat mode. K>2 cannot be encoded
using exactly one bit per original symbol without additional information.
A bijective seeded permutation changes neither K nor information entropy.

For bit b in {0,1}, decoded value x=a XOR ((a XOR c) AND (-b)), with
the mask restricted to 10 bits. For input byte q, output integer
T[q]=sum(j=0..7, x((q>>j)&1)*2^(10j)); exactly ten little-endian bytes.
Truncate the last group to L bytes after validating padding.
This is an exact invertible mapping conditional on the two-symbol dictionary.

## Fast encoding and dictionary search
The binary-first encoder reads five bytes as four 10-bit symbols, probes
eight symbols before allocating, classifies values directly, packs two
four-bit masks into one byte, and applies the seeded dictionary only
when writing the one or two palette entries. If a third value appears,
the general codec restarts and uses direct addressing over 1024 possible
original values. Lookup is worst-case O(1), not an approximate search,
and per-block encoding is O(L). No hash collisions or sorted searches.
The general encoder also maps a value to a seeded ID only on first
encounter. Binary validation does not allocate a 1024-entry seen array.
The optional native decoder and existing OpenCL path remain compatible.

## Storage and scheduling
The codec works on memory buffers, independent of SSD/HDD type. It does
not depend on disk seek latency for symbol search. File-to-file speed
cannot be storage independent: if the destination writes at W GB/s,
verified restoration is at most W GB/s. With compression ratio R and
input rate I, the input can supply at most R*I decoded GB/s.
RAM streaming and disk I/O must be measured separately. The current
archive pipeline still reads/writes files; no claim of equal SSD/HDD
file restore rate. Do not buffer an entire large file to hide this.

A proposed bounded pipeline uses a reader, preallocated ring of 4-16 MiB
batches, CPU and GPU queues, verification, and ordered writer. With
overlap, throughput is bounded by the slowest stage. At CPU/GPU duty
fractions dc,dg, ideal compute capacity <=dc*C+dg*G (assuming rates
scale linearly; real utilization counters do not guarantee this).
If GPU handles share f, the constraints are T*f<=dg*G and
T*(1-f)<=dc*C. PCIe upload/download and memory traffic add bounds;
for GPU-resident output omit host readback only if actually unnecessary.
At 25% duty a single backend needs at least 20 GB/s full-load capacity
to reach 5 GB/s, before verification, transfer and other overhead.
The math model is in tools/symbol-math.cjs. It is a necessary capacity
bound, not a benchmark or an implemented hard utilization controller.

## ASIC
hardware/s10_binary_expand.v is a synthesizable 8-lane, 80-bit output
datapath using only multiplexers and a ready/valid output register.
Ideal throughput = 10*lanes*clock_Hz bytes/s, where lanes counts these
8-symbol modules. One at 500 MHz or four at 125 MHz produces 5 GB/s
if data and output are continuously available. Input index bandwidth
is 0.5 GB/s at 5 GB/s output (plus metadata); output requires 5 GB/s.
The host supplies decoded palette values; a full accelerator needs
archive framing, inverse dictionary initialization, tail validation,
DMA, checksum, error signals and fallback for raw/general/DEFLATE.
A preexisting ASIC with unrelated fixed logic cannot be programmed
to do this. An FPGA can prototype the RTL. No synthesis, timing closure
or silicon throughput has been verified.

## Parallel streaming upgrade

See [GPU and FPGA streaming architecture](GPU-FPGA-STREAMING.md) for the 16-symbol OpenCL tile, two-queue pipeline and 512-bit FPGA streaming core.
