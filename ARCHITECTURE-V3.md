# Symbol10 v3: compression and recovery

V3 is a CPU-first streaming format for individual files. It runs on Windows without OpenCL, Koffi, or a native npm install. Use Node.js 24 for the Zstandard path. The encoder uses level-1 Zstandard when built into the runtime, otherwise raw DEFLATE; `--portable` forces raw DEFLATE for readers that lack Zstandard. A chunk is stored raw if compression would not make the chunk smaller. Recovery data can still make the overall archive bigger than the source, especially for already compressed files.

## Windows quick start

Run these commands in the project folder, quoting file paths with spaces:

```powershell
.\symbol10.cmd pack "C:\Data\my file.bin" "C:\Data\backup.s10"
.\symbol10.cmd verify "C:\Data\backup.s10"
.\symbol10.cmd unpack "C:\Data\backup.s10" "C:\Data\restored.bin"
.\symbol10.cmd repair "C:\Data\backup.s10" "C:\Data\repaired.s10"
```

The launcher supports v3; the equivalent cross-platform entry point is `node symbol10.cjs v3`. Existing v1/v2 archives keep their original commands. Older archives have no v3 recovery data and cannot be repaired by this feature. To migrate a **healthy** older archive, unpack it with its original version and then pack the restored file with v3. V3 currently does not offer GPU decode, directory archives, or firmware support.

## Bounded CPU pipeline

All five v3 commands accept `--workers=N` (1–8) and default to one worker. Packing a regular file of up to 2 MiB stays serial.

```powershell
.\symbol10.cmd pack "large.bin" "backup.s10" --workers=4
.\symbol10.cmd unpack "backup.s10" "restored.bin" --workers=4
```

The main thread owns file handles, validates archive framing before dispatch, and writes completed groups in order. The codec module owns compression, hashing, decompression, and parity recovery. Both the serial and parallel paths use the same codec routines. Each worker handles one group at a time; group payloads move between threads without cloning their backing buffers. Verification sends no decoded output back. Repair returns the corrected stored frame, and extraction returns only verified bytes. The in-flight group count is capped by the worker count, regardless of archive size. Before publishing, the main thread checks the terminator and input file state. Any processing failure leaves the requested output unpublished. The on-disk format is unchanged.

Serial restore reuses a stored-frame buffer, up to 2.5 MiB for an eight-chunk group with two parity shards. To restore a mixed-codec group, it writes the verified raw and decompressed chunk slices directly with vectored I/O. This removes the separate contiguous output buffer of up to 2 MiB used by the worker path. The 2.5 MiB bound applies to the stored frame. Decompressor buffers, recovery scratch space, and the Node.js runtime use additional memory.

On a Raspberry Pi 5 running 64-bit Raspberry Pi OS, use Node.js 24 and the single-worker default to use this CPU path:

```sh
node symbol10.cjs v3 unpack backup.s10 restored.bin
```

## Verified range reads

Use zero-based offsets and lengths in bytes:

```powershell
.\symbol10.cmd read "backup.s10" 1048560 48 "slice.bin"
```

The reader checks the manifests and terminator, but reads only the stored chunks intersecting the requested range. It checks the stored and decoded checksums before publishing the slice. If a selected chunk fails its stored checksum, the reader loads its group and attempts normal parity recovery. A range read does not verify unrelated payloads or parity; use verify for that. An unrelated damaged payload can make full verification fail even when the requested slice is intact. Because v3 and the resilient format have no index, finding the slice still scans all group manifests; time is not constant in the group count. No format change or repack is needed.

## What recovery can and cannot do

- Each group contains up to eight independent 256 KiB chunks, one XOR parity shard over the **stored** bytes, and two independently checksummed copies of its manifest. Each stored and decoded chunk has a SHA-256 checksum.
- Verify and unpack automatically reconstruct **one damaged data shard per group** if the parity and remaining shards are intact. They can also recover if only parity is damaged, or if one manifest copy is damaged, including the terminator. Damage in separate groups is recoverable independently. `repair` makes a clean archive copy; it never edits the original.
- If a group has multiple damaged shards, both manifest copies are unusable, or bytes are missing from a truncated file, recovery can fail. Symbol10 returns an error and publishes no output rather than inventing data. Recovery is not a substitute for a second backup. Checksums detect corruption, not intentional tampering.
- Output is staged in the destination folder, verified for restore/repair, and flushed before publication. Existing paths are never overwritten. As in earlier versions, hard-link publication is atomic where supported; the exclusive-copy fallback can make an in-progress output visible on filesystems without hard links.

## Optional two-shard recovery

Add --resilient to pack to create an S10ARC04 archive. The same Windows launcher and v3 unpack, verify, and repair commands detect the format automatically. Older v3 readers cannot open the new format. Normal packing still creates S10ARC03.

    .\symbol10.cmd pack "important.bin" "protected.s10" --resilient --workers=4
    .\symbol10.cmd verify "protected.s10"

This mode recovers any two damaged data/parity shards per group whose boundaries are still present, including damage to one data shard and one parity shard. Each group still has two manifest copies. It cannot recover a third shard or missing/truncated archive bytes. Full incompressible groups add roughly 25% parity overhead, versus 12.5% in standard v3, plus framing. Recovery remains CPU-only and does not overwrite the original.

S10ARC04 keeps the same fixed manifest size and fields, but the group payload ends in two equal-length parity shards P and Q. P is the usual XOR; Q is the sum over GF(256) of each stored byte times 2 raised to its zero-based slot index, using polynomial 0x11d. Shorter shards are zero-extended. The field at bytes 32–63 stores SHA-256(P || Q). The terminator and summary use the same rules as v3. Readers reject mixtures of the two formats within an archive and validate reconstructed bytes and parity before reporting success.

## On-disk framing

All integers are little-endian. A file is a sequence of groups followed by a terminator. No directory is needed, so memory consumption does not grow with file size. Each group begins with two adjacent copies of the same 704-byte manifest, then its stored chunks in order and the parity shard. Parity has the length of the longest stored chunk; shorter inputs are zero-extended. A full group of incompressible data adds roughly 12.5% parity overhead plus metadata; small groups can add proportionally more.

| Bytes | Field |
| --- | --- |
| 0–7 | ASCII `S10ARC03` |
| 8–15 | Zero-based group ordinal |
| 16–23 | Number of decoded bytes before the group |
| 24–27 | Number of chunks (1–8 for data, 0 for terminator) |
| 28–31 | Parity length |
| 32–63 | SHA-256 of parity (or SHA-256 of the ordered canonical data-group manifests for the terminator) |
| 64–671 | Eight 76-byte chunk records; unused records are zero |
| 672–703 | SHA-256 of the first 672 bytes |

Each chunk record contains three unsigned 32-bit values (codec, stored length, decoded length), followed by the stored and decoded SHA-256 digests (32 bytes each). Codec values are 0 raw, 1 raw DEFLATE, 2 Zstandard. The duplicated terminator has zero chunk count and parity length, records the total decoded length and group count, and must be at EOF. The encoder limits input to 1 TiB. The decoder validates framing and bounds before allocating buffers, and bounds decompression output to the declared size.
