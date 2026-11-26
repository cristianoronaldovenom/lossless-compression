# Symbol10

**Bitline** creates searchable, lossless bundles with automatic compression, exact name and snippet lookup, and two-shard recovery. It also handles one-bit symbols and preserves bit strings that end partway through a byte. See the [Bitline language and quick start](language/BITLINE.md).

Symbol10 is a chunked lossless archive with a dependency-free CPU decoder and an optional OpenCL GPU palette decoder. It uses Node.js 18 or newer. A seeded permutation maps every 10-bit value to one of 1,024 numeric symbols. Each independent 64 KiB block can store a compact symbol palette, fast raw DEFLATE, or the original bytes. A block uses compression only when its payload gets smaller. The archive adds a 72-byte fixed overhead and 32 bytes per block.

## V3: Windows compression and automatic recovery

Use `symbol10.cmd` on Windows (or `node symbol10.cjs v3` on any platform) to pack with Zstandard or portable DEFLATE, verify, unpack with automatic recovery, extract a verified byte range, or repair to a new archive. See the [v3 Windows quick start and recovery limits](ARCHITECTURE-V3.md). Recovery applies to newly created v3 archives only. Add `--resilient` when packing to protect against two damaged shards per group; the same commands read either format.

## V2 archive engine

The new v2 engine bounds memory during packing and opens a range by reading only the groups it intersects. Use `node symbol10.cjs v2 pack input.bin input.s10` to create one. The [v2 architecture guide](ARCHITECTURE.md) covers extraction, archive layout, compatibility, and verification.

## Run

Use `node .\symbol10.cjs --help` to list commands, `node .\symbol10.cjs pack --help` for a single command, or `node .\symbol10.cjs v2 --help` for v2 commands.

```powershell
node .\symbol10.cjs self-test
node .\symbol10.cjs pack input.bin input.s10
node .\symbol10.cjs verify input.s10
node .\symbol10.cjs unpack input.s10 restored.bin
node .\symbol10.cjs read input.s10 0 128 header.bin
node .\symbol10.cjs bench input.bin
```

Use a new output path. Symbol10 flushes a staged file before publishing it and protects existing destinations. On filesystems with hard links, such as NTFS, the completed file appears at once. If the filesystem declines hard links, Symbol10 uses an exclusive copy. On that path observers can see the destination during the copy, and an interruption can leave an incomplete file. Symbol10 requests owner-only permissions where the platform honors POSIX modes and attempts to flush the output directory after publication on POSIX systems. The v1 format supports files up to 64 GiB.

To encode an HTTP or HTTPS download as it arrives, use the download command. It checks the HTTP status and waits for the body to finish before publishing the archive.

```powershell
node .\symbol10.cjs download "https://example.com/file.bin" download.s10 --workers=4 --timeout-ms=30000
```

For general binary pipelines, use `pack -` and give the archive a staging name until the input process reports success.

Use `download --max-bytes=N` to bound the decoded download size and `--sha256=HEX` to match an expected SHA-256 before publication. Both checks apply to the bytes stored in the archive, after any HTTP content encoding has been removed.

`--workers=N` is available for packing local files, binary stdin, HTTP downloads, and CPU-only `unpack`, `read`, and `verify`. Choose from 1 to 16. One worker is the default and runs in the caller's process. Higher counts use a bounded pool, preserve block order, and can help when encoding, decoding, or hashing dominates. Parallel decoding schedules up to 16 chunks per job and verifies every chunk before publishing output. A request that fits in one job uses the serial decoder. The download timeout applies while waiting for the HTTP response or the next body segment. Its default is 30 seconds.

```powershell
node .\symbol10.cjs pack input.bin input.s10 --workers=4
node .\symbol10.cjs verify input.s10 --workers=4
node .\symbol10.cjs unpack input.s10 restored.bin --workers=4
```

For a managed RAM cache, import `makeDictionary(seed)`, `encodeBlock(buffer, dictionary)`, and `decodeBlock(mode, bytes, originalLength, dictionary)` from `symbol10.cjs`. Use an unsigned 32-bit seed and keep one dictionary per seed. Store each block's mode and original length next to its payload. Raw blocks borrow the input buffer, so keep it immutable or copy it before caching. The archive layer adds per-block checksums. Direct callers can apply their own integrity policy.

## Format and recovery

All multibyte fields are little-endian. The header contains the 8-byte magic `S10ARC01`, a 32-bit dictionary seed, and four reserved zero bytes. Payloads run consecutively from byte 16. A 32-byte index entry holds the payload offset (8 bytes), stored length (4), mode (1), reserved bytes (3), and the first 16 bytes of SHA-256 of the decoded block. Modes are raw (0), palette (1), and raw DEFLATE (2). The footer holds the original length (8), index offset (8), SHA-256 of the header, index and first 16 footer bytes (32), then `S10END01` (8).

A palette payload starts with a 16-bit symbol count and one 16-bit symbol ID per palette entry. Indices are packed low bits first at the minimum width for the palette. One symbol requires zero index bits. The original byte count gives the number of 10-bit groups. The final group and final packed-index byte use zero padding. The dictionary is regenerated by Fisher–Yates, using the 32-bit recurrence in the reference code.

A seven-byte input contains 56 bits. It takes six 10-bit symbols, with four zero padding bits in the last symbol. The CPU decoder reads full groups of eight symbols together, then uses the original byte count to write the exact tail and validate its padding.

The decoder checks index integrity, block bounds, exact decoded sizes, and block checksums. Range reads validate the index and decode only the intersecting chunks. An archive that fails validation does not publish a partially restored file. These checks detect corruption; they do not authenticate the archive creator.

Use `node symbol10.cjs info input.s10 --json` to inspect archive sizes, count each codec mode, and check whether the archive uses the raw and palette modes supported by the firmware. The command validates archive metadata. Use `verify` to check every payload.

## Symbol10 language

Symbol10's workflow language uses `.s10l` source files and compiles them to versioned `.s10b` bytecode. Programs can bind values and run archive commands in order. The validator checks operand types, numeric ranges, options, and bytecode integrity before execution. Paths in programs are relative to the working directory. Statements can create files or make HTTP requests when run. If a statement fails, later statements stop and files published by earlier statements remain available.

Create `input.bin` or copy an existing file to that name before running this example.

```powershell
node .\symbol10.cjs lang check .\examples\firmware-archive.s10l
node .\symbol10.cjs lang compile .\examples\firmware-archive.s10l firmware-archive.s10b
node .\symbol10.cjs lang run firmware-archive.s10b
node .\symbol10.cjs info firmware-input.s10 --json
```

## Embedded firmware

The firmware path uses a portable C decoder shared by the desktop emulator and Raspberry Pi Pico USB builds. The host runs Symbol10 language programs and passes raw and palette blocks to the firmware bridge. See [firmware setup and verification](firmware/README.md) for build commands and USB usage.

## Faster decoding

The CPU path reads contiguous batches of up to 128 chunks (8 MiB of original data) and expands groups of eight symbols together. Install the optional dependency on a little-endian 64-bit Windows, Linux, or macOS host to use a GPU exposed by its OpenCL driver.

```powershell
npm install
node .\symbol10.cjs devices
node .\symbol10.cjs self-test --gpu
node .\symbol10.cjs bench-decode input.s10
node .\symbol10.cjs bench-decode input.s10 --gpu
node .\symbol10.cjs unpack input.s10 restored.bin --gpu=auto
node .\symbol10.cjs read input.s10 0 128 header.bin --gpu
```

The same OpenCL kernel targets NVIDIA GeForce GPUs such as the GTX 1660 Super and RTX 5060, Intel integrated and Arc graphics, and AMD Radeon GPUs when the installed driver exposes OpenCL C 1.2 or later. The devices command shows the adapters the driver actually exposes. Physical GPUs without a compatible runtime use the CPU path in automatic mode.

- Use `--gpu=auto` to accelerate larger reads with enough palette blocks. Small reads use the CPU. If no suitable GPU initializes or the driver fails during decoding, automatic mode uses the CPU and still verifies each block.
- Use `--gpu` to require GPU initialization. It tries compatible devices in order, preferring dedicated memory and then compute unit count as a heuristic.
- Use `--gpu=0`, or another index from `devices`, to require a specific adapter. Omit the flag to use the CPU.

The driver supplies the preferred work-group multiple and kernel limits. The decoder uses up to 64 work-items and 32 chunks per batch on shared-memory GPUs, or 128 work-items and 128 chunks on dedicated-memory GPUs, subject to reported limits. Programs can keep an archive open to reuse the validated index, device dictionary, and buffers.

```js
const { openArchive } = require("./symbol10.cjs");
const reader = openArchive("input.s10", { gpu: true });
try {
    const header = Buffer.alloc(Math.min(128, reader.size));
    reader.readInto(header, 0);
} finally {
    reader.close();
}
```

If verification fails after some chunks have been read, `readInto` can leave earlier bytes in the caller's buffer. File-based reads stage their output before publication.

A GPU reader reserves about 4 MiB of device buffers with the shared-memory profile or up to 16 MiB with the dedicated-memory profile and retains its inverse dictionary for its lifetime. On an integrated GPU the driver manages those allocations in shared memory. Each work-group builds one local palette and writes adjacent 32-bit output words in parallel. The CPU validates header and palette bounds, handles raw and DEFLATE blocks, and verifies the decoded bytes. Explicit GPU mode reports initialization or execution failures. The existing v1 file layout supports both decoders.

Use the optional fast-decode packing profile when decode latency takes priority over archive size.

```powershell
node .\symbol10.cjs pack input.bin fast.s10 --fast-decode
node .\symbol10.cjs download "https://example.com/file.bin" fast-download.s10 --fast-decode
```

This profile chooses a symbol palette whenever it saves space and stores other chunks raw. Repetitive byte data that benefits mainly from DEFLATE can take considerably more space in this profile. The default encoder still considers DEFLATE.

The decode benchmark reports the first open and verified read, followed by five passes with the same reader. Warm throughput includes archive reads, GPU transfers when selected, CPU decoding and per-block hashes. It excludes restored-file writes. GPU kernel throughput counts only original palette bytes and device event time. Both rates use decimal GB/s. Compare both paths on the same archive, especially when raw or DEFLATE blocks dominate. The 80 GB/s figure is a performance target.

## Verify changes

```powershell
npm test
npm run test:gpu
node tools/benchmark.cjs --size-mib=8 --runs=3 --workers=4 --gpu=0
```

The CPU tests need no optional native packages. Run `npm ci --omit=optional` for a CPU-only install. GPU testing requires the OpenCL binding and driver. The workload benchmark generates fixed-seed raw, palette, DEFLATE, and mixed fixtures. It measures packing, verification, and full restores, and compares each restored file with the original digest. It compares serial and worker configurations when the worker count exceeds one. Omit the GPU flag to measure the CPU only.

Transparent Windows application opens and system-wide RAM compression require separate operating-system integration.
