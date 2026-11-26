# Symbol10 v2 archive architecture

For the newer CPU-first format with Zstandard and automatic repair, see the [v3 architecture](ARCHITECTURE-V3.md).

Symbol10 v2 stores independent 64 KiB chunks in groups of 16. The group directory locates a group with one fixed-size entry read. Packing buffers one group at a time. Directory entries are written to temporary storage in 64 KiB pages, so directory memory does not grow with input size. The v2 input limit is 1 TiB. A range read can validate the targeted group and chunks without scanning metadata for the entire archive. `verify` checks every group and chunk. Both formats use the same 1,024-symbol palette mapping and raw and DEFLATE codecs.

```powershell
node .\symbol10.cjs v2 pack input.bin fast.s10 --fast-decode
node .\symbol10.cjs v2 info fast.s10
node .\symbol10.cjs v2 read fast.s10 1048560 48 sample.bin
node .\symbol10.cjs v2 verify fast.s10
node .\symbol10.cjs v2 unpack fast.s10 restored.bin
```

The existing top-level commands remain the v1 route. Use v1 when creating archives for the existing firmware bridge. V2 is a separate archive format, with a CPU CLI in this revision. It does not change the device protocol or imply a new throughput benchmark result.

## Bounded parallel decoding (implemented)

```powershell
node .\symbol10.cjs v2 verify fast.s10 --workers=4
node .\symbol10.cjs v2 unpack fast.s10 restored.bin --workers=4
node .\symbol10.cjs v2 read fast.s10 1048560 48 sample.bin --workers=2
```

The reader validates directory bounds and group metadata before dispatch. Only the selected payload is transferred to a worker. Workers verify each decoded chunk's SHA-256 digest before returning bytes. Verify-only workers return no decoded buffer. Extraction writes results in archive order and publishes only after all requested chunks pass. The queue has at most one in-flight group per worker (up to 16); group payloads and outputs are each capped at 1 MiB, apart from worker runtime and metadata. Empty and single-group reads stay serial. Serial is the default because startup and copying can make extra workers slower. V1/v2 archives and v2 targeted validation are unchanged.

## 80 GB/s at 50% GPU: design and qualification

Throughput means decimal GB/s of decoded bytes. Measure kernel-only, warm verified decoding (including reads, dispatch, readback, and SHA-256), and durable restore separately. Define the utilization metric in advance (for example, the benchmark process's busiest Windows GPU engine, averaged over the steady-state window). Engine busy time, hardware execution-unit occupancy and power are different measurements. Do not infer utilization from OpenCL kernel time divided by wall time.

For cold streaming, at stored/decoded ratio r, a GPU-resident path needs at least 80 × (1 + r) GB/s for one input read and one output write. At r = 0.40 that is **112 GB/s** before metadata or scratch. Another full streaming read for CPU verification brings the estimate to **192 GB/s** before extra copies and storage. Cache residency changes physical DRAM traffic; qualify with a working set larger than cache. If 50% means an explicit duty cycle with no decoding during the idle half, 80 GB/s sustained requires **160 GB/s active decode** and **224 GB/s active memory traffic** at r = 0.40. Do not apply that conversion to arbitrary utilization counters. For comparison, a 128-bit LPDDR5-4800 interface has a theoretical 76.8 GB/s peak shared by CPU and GPU.

Next GPU changes, not implemented in this revision:

1. Move full-scan scheduling into a native backend. Prefetch adjacent validated groups into a fixed ring of reusable host/device buffers. Overlap transfer, dispatch and consumption with explicit event dependencies. Verify whether mapped buffers actually eliminate copies on each adapter.
2. Specialize the palette kernel for frequent widths and constant fills. Group jobs by mode without changing output order. Add a GPU-resident API for GPU consumers, with no mandatory CPU readback. Keep raw and DEFLATE on CPU until benchmarks justify accelerating them.
3. Compare on-device SHA-256 with a native CPU verifier. Never expose unverified output to hit the target. Replay only uncommitted work on CPU after a device failure; a corrupt archive must still fail closed. Preserve bounded backpressure, ordered retirement and staged publication.
4. Use sustained palette, raw, DEFLATE and mixed fixtures larger than cache. Record decoded rate and actual utilization in the same window, the workload ratio and codec distribution, system clocks, and the exact output boundary. Qualify only if verified output reaches 80 GB/s with the selected utilization metric at or below 50%. Durable restoration also needs an output sink that can sustain the write rate.

The current GPU route is v1. Use a sustained run to sample the process with Windows GPU Engine counters:

```powershell
node .\symbol10.cjs bench-decode palette.s10 --gpu=0 --seconds=12
```

Local baseline on Intel Iris Xe / Core i5-1250P: a sustained 64 MiB v1 palette run reached **20.067 GB/s kernel-only** and **0.303 GB/s warm verified**. Three usable per-process Windows GPU engine samples read 6%, 7%, and 7%; this is sparse telemetry, not a utilization cap or occupancy measurement. Another run measured 10.311 GB/s kernel-only and 0.183 GB/s verified. On the same 64 MiB corpus, two cold v2 verification runs per configuration measured 0.114–0.125 GB/s serial, 0.108–0.109 GB/s with two workers, and 0.095–0.106 GB/s with four. Keep serial as the default; the worker path was not a speedup on this sample.

### Four-bit OpenCL specialization (implemented in v1)

For four-bit palettes, a GPU work-item can use each packed index once and write five consecutive words per 16 symbols. Tiles are aligned to that unit. The generic kernel loop still handles partial units and other palette widths, and both paths reject invalid indices. CPU archive verification still checks the decoded SHA-256 for every block. No archive bytes or format limits changed.

A same-machine comparison on Intel Iris Xe used three interleaved runs per version, each at least three seconds, on the same 64 MiB four-bit palette archive. Median kernel-only rate rose from 9.208 to 14.137 GB/s; median warm verified decode moved from 0.269 to 0.278 GB/s. Kernel ranges were 7.650–10.431 and 11.314–17.585 GB/s; verified ranges overlapped (0.265–0.287 and 0.267–0.294 GB/s). This confirms a kernel improvement for the tested workload, not a comparable end-to-end gain or a 50% utilization result. Sustained benchmarking of an overlapped transfer and verification pipeline remains open.

### Opt-in GPU verification pipeline (implemented in v1)

```powershell
node .\symbol10.cjs verify palette.s10 --gpu=0 --gpu-pipeline
node .\symbol10.cjs bench-decode palette.s10 --gpu=0 --gpu-pipeline --seconds=12
```

The pipeline collects one GPU batch, then flushes the next dispatch before checking the previous batch’s SHA-256 on the CPU. Two alternating host input buffers keep raw block views valid during overlap. Uploads and readback are still blocking; only the kernel overlaps CPU verification. The reader holds at most one in-flight device batch. It discards the event if verification aborts, and auto mode can retry a driver error on CPU without treating corrupt data as a driver failure. File restore and APIs that deliver decoded bytes use the serial GPU path.

On the same 64 MiB palette archive on Windows/Iris Xe, three interleaved samples per mode gave median verified throughput of 0.467 GB/s serial and 0.480 GB/s pipelined. The ranges overlapped (0.326–0.476 and 0.420–0.495 GB/s). These are verified decode rates without file output; the test does not establish a general speedup, a GPU utilization cap, or the 80 GB/s target.

## Layout

All integer fields are little-endian. The layout starts with a 16-byte header, followed by contiguous groups, a directory, and a 56-byte footer.

| Region | Fields |
| --- | --- |
| Header | 8-byte `S10ARC02` magic, unsigned 32-bit seed, 4 reserved bytes |
| Group metadata | 16 records of 24 bytes. Each record has unsigned 32-bit stored length, 1-byte mode, 3 reserved bytes, and the first 16 bytes of SHA-256 over the decoded chunk. |
| Group payload | Stored bytes for the group's chunks, in metadata order |
| Directory | One fixed 32-byte entry per group. Each contains an unsigned 64-bit group offset, unsigned 32-bit stored group size, 4 reserved bytes, and a 16-byte metadata digest. |
| Footer | Unsigned 64-bit original length, unsigned 64-bit directory offset, 32-byte SHA-256, and 8-byte `S10END02` magic |

The footer checksum covers the archive header and the first 16 bytes of the footer. The directory entry digest is the first 16 bytes of SHA-256 over the concatenated archive header, unsigned 64-bit group ordinal, first 16 bytes of the directory entry, and 384 bytes of group metadata. Digests detect corruption. They provide no author authentication. Range reads intentionally leave unrelated groups unread. If a verified range succeeds while a full verification fails, the affected corruption can reside in a group outside that range.

## Testing

```powershell
node --test test/archive-v2.test.cjs
npm test
```

The cases cover mixed data, a range spanning group boundaries, empty input, corrupted payloads and group metadata, truncated input, no-clobber publication, and v1 round trips.
