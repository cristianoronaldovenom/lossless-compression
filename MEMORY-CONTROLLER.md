# Symbol10 memory + storage controller proposal

Separate cache-line RAM and bulk-storage paths. Preserve existing archive format.
The new memory-page.cjs is an experimental 4 KiB software page representation:
64 independently decodable 64-byte lines, 128-byte directory (13-bit offsets,
3-bit mode), zero page and raw page bypass. Modes: zero, repeated 32-bit word,
signed 8-bit delta from 32-bit base, two actual 10-bit values and 52 indices,
sparse 32-bit words, raw. No dictionary scanning in the RAM path. The existing
archive's 1024-entry forward/inverse mapping is already direct-addressed.

Run node --test test/memory-page.test.cjs and npm run bench:memory -- 4096.
Synthetic workloads are not claims about real application ratios.
Page kind is external. The benchmark assumes 8 bytes external metadata per
page solely for ratio illustration; actual allocator, ECC, mapping and integrity
overhead is not implemented. Prototype checks structural validity, not integrity:
never use for live RAM, swap or persistent storage without those protections.

Hardware: CXL Type 3 memory endpoint plus local ECC DRAM, SRAM translation cache,
banked allocator, atomic remap, raw bypass, parallel independent line decoders.
Keep native host DDR5 for latency-sensitive pages. PCIe DMA accelerator for
storage with independent queues, NVMe, existing verified archive codec, and
optional GPUs. SSD cache/writeback needs power-fail safe journal, flush/FUA,
recovery and end-to-end integrity. No transparent memory or disk driver exists.
Thunderbolt is not a coherent memory interface. CXL requires host support,
licensed/available endpoint IP and verified hardware; don't insert an ordinary
PCIe FPGA between a CPU and a DDR5 DIMM.

hardware/s10_dictionary_sram.v is a two-read-port direct lookup RTL prototype,
with sequential configuration and commit, replicated memories, one registered
read cycle. Host must verify dictionary permutation before commit. No physical
timing closure or synthesis claim. At 250 MHz one cycle is 4 ns; this is local
lookup only, excluding controller, mapping misses, DRAM, interconnect and ECC.
At 250 MHz, five parallel 64-byte line engines would yield 80 GB/s peak
(64*5*250e6). Eight at 200 MHz yield 102.4 GB/s peak. Real throughput limited by
routing, memory channels, metadata and ingress/egress. A dual-channel DDR5-5600
host has 89.6 GB/s theoretical bandwidth before overhead; CXL/PCIe links and
NVMe can be tighter bottlenecks. The RTL lookup is not a line compressor yet.

Next: implement and synthesize parallel line codecs, ECC protected mappings,
stress test allocator and concurrent writes, emulate CXL device, validate
crash consistency, measure P50/P99 latency and actual compression ratio on
representative RAM/SSD traces. Retain uncompressed fallback and mandatory
archive checksums.

The registered line decoder now implements all six modes in RTL, with ready/valid backpressure. CI includes 60 CPU-generated valid line vectors and three invalid vectors, plus 1024 dual-port dictionary requests. These testbenches have not been run locally; timing, synthesis and full controller integration are unverified. Sparse decoding has variable routing and may require additional pipeline stages for timing closure.
