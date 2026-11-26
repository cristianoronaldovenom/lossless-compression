# Symbol10 reliability and performance audit

This ledger records distinct issues observed in the November 2026 baseline. Locations use function or subsystem names so they remain useful as files change. A finding stays open until its fix has observable evidence. Platform behavior that requires a separate machine is tracked as a validation gap.

## Archive I/O and publication

| ID | Baseline weakness | Fix or acceptance check |
| --- | --- | --- |
| 01 | `publishFile` requires hard-link support to save anything. | Provide a documented, tested no-clobber strategy for filesystems that reject hard links. |
| 02 | A known existing destination is detected only after all encoding, decoding or downloading completes. | Reject an existing destination before starting expensive work. Test that a concurrent destination is still protected at publication. |
| 03 | Temporary unlink or directory removal can replace the original operation failure. | Preserve the primary failure when cleanup also fails. Inject both errors. |
| 04 | After a successful hard link, a cleanup error can report failure even though the destination is complete. | Treat publication as a commit point and handle later cleanup failures distinctly. |
| 05 | File contents are flushed before publication, but the new destination directory entry has no explicit durability barrier. | Sync the containing directory where supported and report the platform guarantee precisely. |
| 06 | Process termination can leave staging directories with no lifecycle or recovery procedure. | Add safe interruption cleanup where possible and document how to identify orphaned stages. |
| 07 | Temp files inherit the default mode, allowing access by other users on systems with a permissive umask or directory setup. | Start with owner-only file access where supported and verify published permissions. |
| 08 | A changing file can produce a valid archive of a mixture of older and newer bytes. | Record file identity, size and timestamps using the opened descriptor and reject detectable changes before publication. |
| 09 | `pack` opens named paths without checking source type, so some special files can block or stream indefinitely. | Establish regular-file requirements for paths and a supported explicit stream path. |
| 10 | File handle cleanup can mask processing errors if close itself fails. | Keep the originating error and assert cleanup on failure. |
| 11 | Unpack writes each decoded block separately despite batching reads. | Use vectored output or a reusable batch output buffer and keep short-write handling. |
| 12 | Pack and download issue an output write for every block, including four-byte palette blocks. | Coalesce payload writes within a fixed memory budget. |
| 13 | `archiveWriter` builds one Buffer per entry and concatenates the whole index. | Use slabs or a bounded index writer and measure peak memory on a high-block-count workload. |
| 14 | The archive version caps inputs at 64 GiB, regardless of available disk space. | Define and test any larger-file representation separately. Preserve v1 compatibility. |
| 15 | A full packed archive can exceed the input while each codec selection considers only payload size. | Make archive overhead explicit and report the final ratio. |
| 16 | `pack -` cannot verify whether an upstream producer succeeded. | Give pipeline callers an explicit staging or expected digest workflow that prevents publishing failed upstream data. |
| 17 | There is no fault test for short reads, short writes, full disk, or publication permission failures. | Exercise each I/O boundary with injected faults and verify destination and source invariants. |

## Codec and reader

| ID | Baseline weakness | Fix or acceptance check |
| --- | --- | --- |
| 18 | The exported `decodeBlock` accepts a plain object with a byte-like length in raw mode. | Validate byte arrays at public boundaries. A baseline call with `{length: 1}` reproduced the issue. |
| 19 | The exported encoder can accept invalid caller-provided dictionaries silently. | Check table shape, inverse and permutation or restrict the boundary to validated library dictionaries. |
| 20 | The public dictionary exposes mutable forward and inverse arrays. | Define ownership and guard against mutation corrupting caller-owned blocks. Test mutation behavior. |
| 21 | `makeDictionary` silently coerces seeds such as fractions or nonnumeric inputs. | Specify the accepted seed domain and test conversion boundaries. |
| 22 | Raw block results borrow caller memory. Editing a buffer after caching it can change a cached payload. | Define and test copy versus borrow semantics for the public API. |
| 23 | The decoder returns different container types depending on codec. | Provide a consistent byte API or document the exact union and test interoperability. |
| 24 | The direct codec API has no integrity metadata or check. | Add a verified cache wrapper or a documented digest contract for direct callers. |
| 25 | Archive hashes detect damage, but anyone can rewrite an archive and its hashes. | State the trust boundary. Add authenticated archives only under an explicit authentication requirement. |
| 26 | Per-block hashes allocate a new hash object and digest buffer. | Profile batched verification while retaining equivalent integrity checks. |
| 27 | The encoder always constructs a candidate palette before calling DEFLATE. | Measure and bypass expensive candidate work for inputs unlikely to benefit. |
| 28 | The encoder computes and stores a per-symbol index even when a chunk has one repeated symbol. | Add a measurable fast path with exact padding and original output parity. |
| 29 | Palette validation allocates and zeroes a symbol-sized bitmap on every block. | Reuse bounded scratch when ownership permits. Verify malformed layouts still fail. |
| 30 | Large incompressible inputs run most of the work of a speculative DEFLATE encode for little benefit. | Add a measured low-benefit bypass outside the best-ratio profile. |
| 31 | Node processes chunks and cryptographic verification serially on one thread. | Add bounded parallel work with ordered output and verify failure propagation. |
| 32 | Opening a large archive reads, hashes, and scans its complete index before a tiny range is available. | Measure open latency across index sizes. Consider a separately versioned paged index with independently verifiable pages. |
| 33 | CPU decoding allocates per-batch GPU-related arrays even with no accelerator. | Keep GPU preparation off the CPU path. |
| 34 | Ineligible automatic GPU requests can repeatedly scan large ranges for palette density. | Index eligibility once or bound the decision work to the batch being decoded. |
| 35 | A one-block region is fully decoded and hashed on every repeated short read. | Add an opt-in bounded verified block cache and state the archive immutability assumption. |
| 36 | The reusable reader cannot return a Promise or apply backpressure through its visitor callback. | Provide an async consuming API where needed, with ordering and cancellation tests. |
| 37 | `readInto` can partially mutate a destination buffer before a late batch fails. | Document partial-read semantics or add a transactional variant. Test a late corrupt chunk. |
| 38 | Invalid reader GPU options are treated as a device request instead of being rejected at the option boundary. | Validate GPU mode and index type before open. |
| 39 | Callback throws or source failures leave reusable reader cleanup completely to the caller. | Provide reliable ownership examples and test close and reuse after failures. |
| 40 | The archive limit and schema are duplicated across JavaScript, docs, and kernel constants. | Add consistency checks or generate repeated constants from one source. |

## Streaming and CLI

| ID | Baseline weakness | Fix or acceptance check |
| --- | --- | --- |
| 41 | A server that stalls before producing headers has no explicit application deadline. | Add configurable connection or header cancellation and test a stalled endpoint. |
| 42 | A server that stalls after sending a partial body has no explicit application idle limit. | Add configurable body idle cancellation and verify no final archive is exposed. |
| 43 | Users cannot cancel a download through a public API or CLI option with predictable staging cleanup. | Add an abort signal contract and exercise cancellation before and during a transfer. |
| 44 | Compression and file writes block the event loop while consuming a download. | Bound async or worker work while preserving stream backpressure and cancellation. |
| 45 | HTTP and fetch errors are mostly surfaced without a useful stage or cause. | Report the URL context without credentials, plus stage and OS or protocol cause. |
| 46 | HTTP collection has no configurable byte budget below the v1 archive maximum. | Support a caller-selected maximum and enforce it while streaming regardless of header values. |
| 47 | Download has no user-supplied expected digest. A successful but unintended response is archived faithfully. | Verify a supplied digest over the actual decoded source bytes before publication. |
| 48 | Download HTTP responses can be content-decoded by fetch even after requesting identity encoding. | Define which bytes are archived and test unexpected gzip encoding on the wire. |
| 49 | CLI usage documents no recovery method for unavailable OpenCL beyond removing the flag. | Give actionable diagnostics distinguishing missing driver, binding, unsupported device, and bad index. |
| 50 | CLI input errors often print the entire usage or a bare underlying error. | Return short contextual errors and maintain stable exit behavior in tests. |
| 51 | There is no archive inspection command showing original and stored sizes or mode distribution. | Add scriptable archive metadata output to support choosing codec profiles. |

## GPU portability and throughput

| ID | Baseline weakness | Fix or acceptance check |
| --- | --- | --- |
| 52 | One failing platform or device query aborts discovery of all GPUs. | Treat enumeration failures per platform or device and test mixed good and faulty adapters. |
| 53 | Driver name, vendor and version reads assume a fixed 1 KiB query response buffer. | Query actual string sizes or cap them with an explicit diagnostic. |
| 54 | Availability checks omit actual local memory and two-dimensional dispatch constraints. | Validate the kernel's launch and memory requirements per adapter before dispatch. |
| 55 | Every new GPU reader recompiles the same kernel and recreates the context. | Measure initialization and cache safe, reusable device state. |
| 56 | GPU execution relies on profiling support even when the caller only needs decoded bytes. | Keep the data path usable if timing queries fail or disable them outside benchmarks. |
| 57 | The device result copies a full chunk-sized range per row, even past a partial output block. | Avoid reading unwritten tail bytes or zero them and test the public backend contract. |
| 58 | Mixed batch uploads include raw and DEFLATE bytes already decoded on the CPU. | Pack only GPU inputs when that reduces total transfer cost. |
| 59 | Uploads, status initialization, dispatch, status read and output read block on a single queue. | Measure batching and overlapping IO with explicit lifetime and event handling. |
| 60 | Only palette decoding is GPU accelerated. Raw and DEFLATE costs constrain archive throughput. | Benchmark codec modes separately and validate any new accelerated mode with the same checks. |
| 61 | The fixed minimum of eight palette blocks can choose a slower route on some devices or data. | Report and tune selection against representative measurements on the actual device. |
| 62 | Automatic ranking compares compute-unit counts across device vendors. | Keep explicit adapter selection and validate ranking against representative measurements. |
| 63 | Automatic fallback resets already accumulated GPU counters if the backend fails. | Preserve completed counters across fallback and verify benchmark attribution. |
| 64 | The kernel allocates local palette storage for up to 1,024 values on each work-group. | Check whether sizing by width improves occupancy without more dispatch overhead. |
| 65 | A stuck or terminated driver call is in the main CLI process. | Evaluate isolating acceleration behind a bounded worker process if a hard-failure fallback guarantee is required. |
| 66 | Decode timing only covers one adapter locally and is sensitive to workload and cache state. | Produce a reproducible workload matrix and report settings, throughput and verified output. |
| 67 | The 80 GB/s target has no matching end-to-end result. | Validate against a defined target workload and show kernel, host transfer, decoded verification and output write timings. |

## Release verification and operating-system scope

| ID | Baseline weakness | Fix or acceptance check |
| --- | --- | --- |
| 68 | The stated runtime minimum is only described in the README. | Add package metadata and run the test matrix at the minimum supported version. |
| 69 | The CPU test command does not include a maintained Windows, Linux and macOS matrix. | Run deterministic checks across supported OS and Node versions in CI. |
| 70 | NVIDIA, AMD and Apple devices lack model-specific hardware evidence. | Record the actual driver and run decode parity, fallback and benchmark checks when hardware is available. |
| 71 | Fresh install with optional native dependencies disabled has no explicit acceptance test. | Test the CPU CLI in a clean install without Koffi or an OpenCL runtime. |
| 72 | The baseline has no independently pinned archive fixture for backward compatibility. | Add a versioned fixture or independent writer with known decoded bytes and metadata. |
| 73 | The baseline has limited malformed-index and truncated-payload coverage. | Test randomized boundary cases with a seeded generator and hand-built negative cases. |
| 74 | The self-test uses nondeterministic input in cases that expect exact codec choices. | Replace sensitive fixture data with reproducible inputs. |
| 75 | Benchmark averages hide cold startup, variance, and short-read latency. | Report repeated medians and distribution, plus measured output write and flush time. |
| 76 | Archive decoding and the managed-block API require application integration. | Define a separate rollout and compatibility strategy for transparent Windows opens or system-wide RAM compression. |

## Follow-up findings from the new paths

| ID | Weakness | Fix or acceptance check |
| --- | --- | --- |
| 77 | Exclusive-copy publication can expose an incomplete byte stream on a filesystem without hard links. | Document the fallback visibility guarantee or use an atomic no-replace primitive for each target filesystem. |
| 78 | Exclusive-copy publication can require a second full archive or restore worth of free disk space. | State the scratch requirement and test an out-of-space copy without an incomplete output. |
| 79 | The worker pool creates the requested number of threads before seeing whether the input has enough chunks. | Bound startup work for small known-size inputs, measuring serial and worker crossover. |
| 80 | A stalled oldest worker can delay reporting a later failure because results are consumed in order. | Fixed: fatal pool errors race ordered retirement and close every worker immediately. |
| 81 | Worker packing still copies each input chunk to a transfer buffer, and copies encoded outputs that share a zlib allocation. | Measure whether owned streaming buffers or a bounded reusable pool reduce overhead. |
| 82 | Checking regular-file type only after an open cannot prevent a blocking open on some special paths. | Use a supported nonblocking open and descriptor check on systems that expose that behavior. |
| 83 | A GPU reader can be valid even though a few individual dispatch configurations on that driver fail. | Test launch at partial, small, full and maximum batches per model and retain automatic fallback. |
| 84 | API consumers need an exact local file path to import the project because the package has no public entry point. | Add and test an explicit package entry point if general programmatic installation is in scope. |
| 85 | Selection metrics report completed GPU work but do not isolate CPU time, transfer time or checksum time. | Instrument each stage with a common denominator per workload and report which stages dominate. |
| 86 | An exclusive copy can succeed before the destination flush fails. The command can report failure even though a destination now exists. | Report post-commit durability failures distinctly and verify that retries preserve the destination. |
| 87 | A response can stay open indefinitely by sending data just before each idle deadline. | Add a separate optional total deadline and verify that continuous slow progress still stops at that deadline. |
| 88 | Reentrant visitor code can close an archive during a multi-batch read. The outer call can then try to reuse its closed descriptor. | Define reentrancy behavior and verify that traversal stops before a subsequent descriptor read. |
| 89 | The CPU decode pool uses a fixed 1 MiB output span per job. A sub-1 MiB archive can pay worker startup and dispatch costs with no parallel decode. | Measure and tune dispatch granularity or route one-job requests through the serial decoder. |

## Language and firmware integration findings

| ID | Finding | Evidence or acceptance check |
| --- | --- | --- |
| 90 | The baseline has no reproducible archive workflow format. | Source and compiled-bytecode tests now verify ordered pack, verify, restore and range reads. |
| 91 | The baseline cannot validate an entire workflow before filesystem actions. | Compiler and bytecode validation run before execution. Invalid-program tests check absence of early outputs. |
| 92 | The baseline has no archive-level report of unsupported embedded codec modes. | `info --json` distinguishes firmware-supported raw and palette blocks from DEFLATE. The integration test verifies both cases. |
| 93 | The baseline codec needs a desktop Node runtime. | The C firmware core and desktop emulator provide a native decoder for raw and palette blocks. Keep board-build and runtime evidence separate. |
| 94 | The firmware bridge and desktop archive reader each parse the v1 index. | Share index validation or cross-test both implementations for all malformed metadata cases. |
| 95 | The firmware bridge still relies on a hard link for publication. | Reuse the desktop's exclusive-copy fallback or document the required filesystem support. |
| 96 | A failed language instruction leaves earlier outputs published. | Document the commit boundary and test that subsequent instructions are skipped. Workflow rollback remains a separate feature. |
| 97 | The workflow interpreter creates a new Node process for every opcode. | Compare to direct in-process dispatch and amortize startup without losing error and argument validation. |
| 98 | USB transport has no test against a physical board. | Verify enumeration, disconnect recovery and multi-block byte parity on each supported Pico model. |
| 99 | Embedded decoding still requires host-side archive parsing and orchestration. | Standalone archive and bytecode execution on-device require a storage interface and a separate firmware runtime. |
| 100 | The firmware handles one request and response at a time. | Measure sustained transfer on hardware before evaluating deeper pipelining. |

## Fix evidence

| Finding | Change in the current worktree | Verification status |
| --- | --- | --- |
| 01 | Publication tries the staged hard link first, then exclusive copy for recognized filesystem errors. | The test suite injects an unsupported hard link and exercises exclusive publication. Real filesystem coverage remains open. |
| 02 | Publication checks the destination before writing a stage, then commits using an exclusive operation. | Tests check existing destinations and two competing unpack processes. |
| 03–04 | Staging cleanup emits a warning and preserves the earlier result. | Code reviewed. Cleanup failures still need fault-injection coverage. |
| 11, 17 | Restore writes a verified batch through vectored I/O and retains short-write handling. | Injected short reads and writes preserved all bytes. Injected `ENOSPC` left no staged or published output. Permission and cleanup failures still need separate tests. |
| 13 | The encoder stores entries in index pages and hashes and writes the same pages. | The worker suite checks an archive crossing a complete index page. Peak memory at the format limit remains unmeasured. |
| 18–19 | Public codec calls validate input byte types and table shapes. | The original non-byte case is rejected. Dictionary content and mutation remain separate checks. |
| 08–09, 82 | Packing checks the opened source descriptor, rejects nonregular paths, and checks size and timestamps before publication. Path opens request nonblocking behavior where the runtime exposes it. | Regular files and explicit binary stdin run locally. Concurrent source edits and special path types still need injected or platform tests. |
| 21, 38 | Dictionary creation and programmatic GPU selection reject invalid option types at the API boundary. | API tests exercise the maximum seed, invalid numeric values and invalid GPU option types. The local GPU suite exercises explicit index zero. |
| 26, 28, 33 | The codec reuses encode scratch, recognizes zero-filled blocks early, and avoids constructing descriptors for CPU-only decode batches. The main process uses one-shot hashing where available. | Existing mode and range tests pass. Isolated throughput and allocation evidence is still open. |
| 31, 44, 79 | The bounded codec pool starts workers only when enough jobs arrive to use them. It parallelizes packing and CPU decode with ordered output and per-block verification. | Local worker tests passed for 1, 2 and 4 encoding workers, the index-page boundary, cross-batch range extraction and rejection without publication. File I/O remains on the main thread. |
| 80 | Worker failures are observed independently from ordered successful results. | An injected later failure interrupts a stalled earlier result and closes every worker. |
| 41–42 | Download applies an explicit inactivity deadline while awaiting headers or each body read. | Local HTTP stall tests cover expiry and output cleanup. Cancellation by a caller or process signal remains separate. |
| 45–48 | Download failures identify the network stage and origin. Configurable byte limits and expected SHA-256 apply to decoded response bytes. | The download suite exercises an encoded body, a matching digest, excessive size and a mismatched digest. |
| 52–54 | OpenCL enumeration isolates failing platforms and adapters, uses variable-length string queries, and checks two-dimensional dispatch and local memory. | Real Intel discovery works. A multi-driver failure matrix remains open. |
| 56–57, 59 | GPU output remains usable when device profiling fails. The backend clears or trims unwritten output, combines status and output transfer, and initializes status on the queue. | GPU parity and output boundary suites run on Intel Iris Xe. More extensive transfer overlap remains open. |
| 58, 63 | Mixed batches omit unrelated bytes from GPU uploads when the savings justify compaction. Automatic fallback retains previous device counters. | Mixed-mode parity ran on Intel. Compact-upload savings and timing across a mid-run fallback still need targeted measurements. |
| 40 | OpenCL now receives host-derived descriptor, chunk and header sizes at compile time. | The GPU parity suite checks payload shape across widths and tails. The archive schema still exists separately from benchmark and test fixture readers. |
| 69, 71–74 | CI configuration covers multiple OS and Node versions. The test suite adds independent v1 fixtures, deterministic vectors, malformed indexes and payloads, fallback simulations and publication races. | Two Windows integration runs and a clean offline install with optional dependencies omitted passed. CI definitions alone do not prove Linux or macOS runs. |
| 66, 75 | `tools/benchmark.cjs` runs a fixed seed corpus with raw, palette, DEFLATE and mixed blocks. It reports elapsed times, medians and ranges across repeated CLI operations. | On Windows x64 with Intel Iris Xe and Node v24.22.1, all restored SHA-256 values matched in a two-pass, 4 MiB-per-workload run. Warm palette kernel rates were 14.66 and 15.68 GB/s on palette and mixed data, respectively. Warm verified archive rates were 0.109 and 0.132 GB/s. Serial verification and restore won the cold 4 MiB CLI comparisons. A 64 MiB palette verification run measured 11.6–26.2 MB/s with serial decoding, 17.6–19.0 MB/s with two workers and 15.9–29.8 MB/s with four workers. The ranges overlap. Isolated first-range latency remains open. |
| 88–89 | Traversal checks whether a visitor closed the reader. CPU requests fitting a single decode job stay on the serial path. | Coverage includes closing a reader from its visitor and serial and multi-job CPU restores. |

## Firmware and language verification

- The Windows native C emulator passed 418 frame comparisons and restored a v1 archive generated by compiled `.s10b` bytecode. The suite also checks malformed frames, truncated input, checksum failure, overwrite protection, and explicit rejection of DEFLATE.
- Pico SDK 2.2.0 and Arm GCC 14.2.1 built USB firmware for `pico` and `pico2`. Picotool identifies the generated UF2 files as `rp2040` and `rp2350-arm-s` respectively. The USB SDK sources use GNU C extensions while the shared core builds in standard C11. Testing USB on a physical board remains open (98).
- The bridge and desktop share one v1 parser and one staging and publication implementation (94–95). The bridge rejects DEFLATE before starting the transport. The exclusive-copy fallback retains its documented filesystem limitations.
- The language runtime now dispatches each validated opcode in the same Node process (97). Language tests verify that subsequent instructions stop after a failure and that prior outputs remain available.
- The ledger tracks 100 findings and coverage gaps. Entries without fix and verification evidence remain open.

## Verification to record with fixes

- Retain file names, archive version, workload sizes, hash or byte comparisons, codec modes, runtime and selected device for each test run.
- Verify that a failed decode leaves no newly published output and that a preexisting destination retains its original bytes.
- Keep evidence for CPU-only, automatic fallback, and strict GPU runs separate.
- The ledger records 76 baseline and 24 follow-up findings. These totals count issues, limits and coverage gaps. A passing test establishes evidence for the exercised configuration.
