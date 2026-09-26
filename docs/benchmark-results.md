# Local Workers results — 2026-09-25

These are the preserved **pre-optimization** results. See the [2026-09-26 decoder follow-up](decoder-allocation-optimization.md) for the current implementation's controlled before/after comparison and refreshed Worker validation. Historical first-decode timings below should not be treated as its current latency.

The full local suite passed field-for-field validation for eight synthetic workloads and 126 malformed-packet cases. All bounded suite phases stayed below the diagnostic 96 MiB accounting threshold; the largest observed sum was 91,091,654 bytes. The deliberately unguarded eight-request stress run failed the 128 MB check. These are measured local results, not a guarantee about total production isolate memory.

Environment: Apple M4 Pro, macOS arm64, Node 22.15.0, Wrangler 4.140.0, workerd 1.20260923.1, compatibility date 2026-09-25. The full suite Worker bundle SHA-256 is `aa3de5cb52ad3e2e7916c4064e4afdbd1fe5cfec212ccb8590256ae542d8ace5`. All inputs are invented synthetic fixtures. See [methodology](benchmark-methodology.md), [full raw suite](../bench/results/suite.json), [codec matrix](../bench/results/matrix.json), [memory rerun](../bench/results/memory.json), and [quick smoke](../bench/results/quick.json).

The acceptance tables and four reports were refreshed after adding bounded startup and confirmed child/group/port shutdown. Their runner-source SHA-256 is `692ddcf626adee59a13cb357272d698d64d2589e7e2d5d2ee7dca7f1c56a4283`; the Worker code and fixture bytes did not change. The native codec probe and failing stress report remain historical evidence from the earlier runner.

## Decode time and packet size

Times are milliseconds. First decode means the first unpack in a fresh Worker after fixture encoding; it excludes startup and I/O. Warm p95 is the p95 of nine batch averages, not a production request latency percentile. Memory sampling runs alongside timing. The runtime clock has millisecond resolution, and the fixture labels are scenarios rather than measured production percentiles.

| Scenario           |   Rows | Packed bytes | JSON bytes | First decode | Warm median | Warm p95 |
| ------------------ | -----: | -----------: | ---------: | -----------: | ----------: | -------: |
| Small              |     10 |          580 |      2,547 |            2 |        0.07 |      0.1 |
| Median             |  1,000 |       39,478 |    256,545 |           26 |         7.9 |     53.5 |
| p95                |  5,000 |      192,033 |  1,282,816 |           14 |         9.5 |     11.0 |
| Maximum            | 10,000 |      380,036 |  2,565,536 |           28 |        20.0 |     24.5 |
| RSA v2 base64      | 10,000 |    2,644,776 |  5,365,536 |           60 |        27.5 |     31.0 |
| RSA v3 hexadecimal | 10,000 |    2,644,803 |  7,045,536 |           57 |        31.0 |     42.0 |
| Unicode filenames  | 10,000 |      380,226 |  3,085,526 |           31 |        24.0 |     31.0 |
| Long paths         | 10,000 |      381,065 |  7,385,536 |          130 |        35.5 |     85.0 |

The refreshed run shows substantial wall-clock variation, particularly in the 1,000-row and long-path scenarios. These observations are not stable latency targets or evidence of a performance regression; scheduling, garbage collection, and inspector overhead are included. Raw samples and their spread are retained rather than selecting a faster run.

The 10,000-row SHA-256 packet is 85.2% smaller than its four-field JSON representation. JSON.parse is faster than validated protocol decoding in these runs; it does not perform the protocol's digest, canonical encoding, path, size, or decompression checks. Raw JSON timing samples remain in the reports.

## Encoding comparisons

All matrix cases use the same 10,000 rows and monotonic sizes. Node encoded every packet, and workerd decoded it. This lets the comparison include Zstandard despite the [known Worker compressor failure](https://github.com/cloudflare/workerd/issues/6769). The native decoding matrix passed all 12 combinations, with no 96 MiB accounting crossings. Reusing one isolate means these timings include order, JIT, and garbage-collection effects; small latency differences are not conclusive.

| Names / codec / sizes         | Packet bytes | Warm median ms |
| ----------------------------- | -----------: | -------------: |
| Raw / none / absolute         |      869,885 |           18.0 |
| Prefix / none / absolute      |      613,653 |           15.5 |
| Raw / Brotli / absolute       |      377,021 |           16.0 |
| Prefix / Brotli / absolute    |      362,646 |           22.5 |
| Prefix / Zstandard / absolute |      386,805 |           19.5 |
| Prefix / Brotli / delta       |      335,392 |           16.5 |

Prefix encoding reduces uncompressed packet size by 29.5%; Brotli plus prefix encoding reduces it by 58.3% relative to raw/uncompressed. Delta sizes reduce the prefix/Brotli packet a further 7.5%, but require nondecreasing sizes after filename sorting and therefore cannot be enabled for arbitrary manifests. The default remains absolute sizes. Automatic compression can select a successful Brotli/raw representation when the native Zstandard compressor fails. Explicit Zstandard encoding retains an explicit error on the affected runtime; [probe data](../bench/results/probe.json) records that limitation.

## Memory and admission control

The following values are the largest same-sample sum of CDP `usedSize`, `backingStorageSize`, and `embedderHeapUsedSize`, in decimal MB. They include the synthetic fixture and benchmark baseline. The debugger pauses at both decoded-block and decoded-entry allocation checkpoints. Raw reports also retain used heap, allocated heap capacity, external backing, embedder heap, timestamps, and process RSS separately.

| 10,000-row scenario | Paused decode checkpoints | Two retained outputs | Two concurrent requests | Eight requests, one admitted | Twenty sequential admitted requests |
| ------------------- | ------------------------: | -------------------: | ----------------------: | ---------------------------: | ----------------------------------: |
| SHA-256             |                      29.8 |                 30.8 |                    36.0 |                         30.8 |                                43.0 |
| RSA v3              |                      57.6 |                 54.5 |                    68.6 |                         53.2 |                                91.1 |
| Long paths          |                      59.1 |                 68.8 |                    83.6 |                         55.3 |                                61.3 |

Every eight-request admitted workload returned one successful decode and seven HTTP 429 responses. The request reserves 72 MiB before decode and holds that reservation until its output has been consumed. A nominal 24 MiB is reserved for surrounding application state within a 96 MiB planning ceiling. Applications must size that allowance against their actual baseline and continue accounting for cached outputs after a request finishes.

The [unsafe stress report](../bench/results/stress-unsafe.json) is retained as failing evidence, not counted as a passing benchmark:

| Unguarded scenario | Eight retained outputs, bytes | Eight concurrent requests, bytes | Outcome                                                  |
| ------------------ | ----------------------------: | -------------------------------: | -------------------------------------------------------- |
| SHA-256            |                    45,202,888 |                       78,335,001 | Below diagnostic threshold in this run                   |
| RSA v3             |                    88,460,639 |                      118,705,404 | Concurrent phase exceeded 96 MiB diagnostic threshold    |
| Long paths         |                   102,824,182 |                      137,647,208 | Exceeded 128,000,000-byte hard threshold; command failed |

The largest workerd-process RSS sample in the full suite's memory workloads was 395,706,368 bytes. Process RSS includes runtime, native allocations, memory retained from fixture encoding, and potentially multiple isolates; it is not Cloudflare's per-isolate accounting. CDP may omit native codec workspace and sampling can miss shorter peaks. Neither metric can establish an unconditional 128 MB production guarantee. The operational requirement is bounded inputs plus admission control and retained-output limits, followed by measurement in the surrounding production application. No deployment was performed.
