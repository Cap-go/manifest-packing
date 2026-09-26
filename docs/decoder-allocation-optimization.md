# Decoder allocation follow-up — 2026-09-26

The synchronous decoder became faster without changing protocol v0, its public API, or the packed bytes. For the synthetic 10,000-entry delta-path manifests, warm median decoding fell from **35 to 20 ms for RSA v2** and **38 to 27 ms for RSA v3**. First-decode medians fell from **51 to 33 ms** and **47 to 37 ms**, respectively. These are controlled local measurements, not production endpoint latency guarantees.

## What changed

| Change                                           | Work avoided                                                                      | Compatibility                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Reuse a 512-byte hash-text buffer for one decode | Repeated temporary UTF-8 input buffers when hashing each reconstructed delta path | Same SHA-256 over the exact original hash text; longer literal hashes retain the old path |
| Reuse each binary reader's `Buffer` view         | Per-entry wrapper/view construction when restoring hex/base64 checksums           | Same bytes, bounds checks, and output strings                                             |
| Fast path for URI-safe filenames                 | Splitting every filename into segments, mapping, then joining                     | Unicode/reserved characters still use exact URI encoding                                  |
| Compute shared prefix byte lengths once          | Repeated byte-length calculation of identical header prefixes                     | Same reconstructed-path size checks                                                       |

The extra 512-byte scratch allocation is included in the decoder's working-memory budget. It is local to one decode, not shared between requests. No integrity, canonical encoding, path, integer, or resource checks were disabled.

## Controlled comparison

Baseline is commit `b8b099401f78ea8c52c648fbd250c82af7d682ac`. Both implementations decode identical packets produced by that baseline encoder under Node. Each scenario/variant/round starts a fresh Wrangler/workerd process. Packet preparation does not invoke the Worker encoder or decoder. The first decode is measured before checking its complete tuple fingerprint; then three warmups precede nine individually timed requests. Variant order alternates AB/BA between three rounds.

All cases contain 10,000 synthetic entries. First columns are medians of three fresh-isolate observations; warm columns are medians of 27 observations. The full distributions, per-round medians, exact source hashes, block codecs, and packet sizes are retained in [the final comparison](../bench/results/decoder-comparison-scratch.json). All 72 first-decode result sets passed exact four-field fingerprint comparison.

| Scenario                             | Metadata codec | Packed bytes | First before → after, ms | Warm before → after, ms |
| ------------------------------------ | -------------- | -----------: | -----------------------: | ----------------------: |
| RSA v2, delta                        | None           |    2,601,109 |                  51 → 33 |                 35 → 20 |
| RSA v3, delta                        | None           |    2,601,109 |                  47 → 37 |                 38 → 27 |
| RSA v2, legacy                       | None           |    2,601,122 |                  16 → 13 |                   8 → 6 |
| RSA v3, legacy                       | None           |    2,601,122 |                  21 → 17 |                 12 → 11 |
| RSA v2, mixed                        | Zstandard      |    2,638,063 |                  32 → 23 |                 19 → 15 |
| RSA v3, mixed                        | Zstandard      |    2,638,255 |                  34 → 27 |                 23 → 17 |
| RSA v2, mixed, Worker fallback codec | Brotli         |    2,644,776 |                  35 → 29 |                 24 → 21 |
| RSA v3, mixed, Worker fallback codec | Brotli         |    2,644,803 |                  39 → 33 |                 28 → 23 |
| RSA v3, mixed, uncompressed metadata | None           |    2,781,105 |                  29 → 25 |                 19 → 15 |
| SHA-256, delta                       | None           |      361,107 |                  45 → 31 |                 30 → 19 |
| SHA-256, Unicode delta filenames     | None           |      361,101 |                  50 → 39 |                 36 → 30 |
| SHA-256, long delta filenames        | None           |      361,179 |                  62 → 33 |                 45 → 23 |

There was no median regression among these tested scenarios. There are still outliers: the optimized RSA v3 mixed/Zstandard first-decode observations were **27, 27, and 96 ms**; baseline SHA-256 delta was **45, 39, and 91 ms**. They are included, not discarded. Three first-decode observations are not enough to estimate a production tail-latency distribution.

Environment: Apple M4 Pro, macOS arm64, Node 22.15.0 driver, Wrangler 4.140.0, workerd 1.20260923.1, compatibility date 2026-09-25. Timers have millisecond resolution. The inspector is connected to allow the local clock to advance; CPU profiling and memory polling are **not** active during this paired timing comparison. There is no forced GC, overlapping load test, production database fetch, or response serialization inside the timed region.

The final library-source fingerprint is `d7d47c4f4d232c86b5e51a62e9acbd027fe12c639b27b9dc6fed18285d1fba0c`: SHA-256 over sorted immediate `src/*.ts` file names (without the directory) followed by their raw bytes, without separators. Every file was checked against the comparison's candidate hashes after the run.

### Why these numbers differ from the earlier 57–60 ms

The original suite encoded fixtures inside the Worker before its first decode and polled memory alongside timing. It used mixed paths and the runtime's Brotli fallback. This comparison prepares packets outside the Worker and separates timing from profiling/memory monitoring. Node automatic encoding can select Zstandard where this workerd version's encoder fails.

Therefore, **do not subtract the new numbers from the historical 57–60 ms and attribute the whole difference to optimization**. The table above compares the same input bytes, runtime, and measurement procedure before and after. Its explicit mixed/Brotli cases reproduce the earlier encrypted packet sizes exactly.

## Where the time goes

The [final CPU/profile report](../bench/results/decoder-profile-final.json) uses separate fresh processes and coarse stage instrumentation in temporary source snapshots, never in the shipped library. For RSA v3 delta, the metadata block is already uncompressed: 2,599,832 bytes. Only the 73,768-byte filename block is compressed, down to 1,221 bytes.

| Stage, optimized RSA v3 delta                        | Instrumented observations                        |
| ---------------------------------------------------- | ------------------------------------------------ |
| Integrity digest, header parsing, and resource setup | 1 ms in each of 12 samples                       |
| Both block decompressions                            | Below the 1 ms clock resolution in these samples |
| Entry decoding, path reconstruction, and validation  | 23–34 ms; median 30 ms                           |

The allocation and per-entry reconstruction work dominate here, not decompression. Sampling showed substantial buffer conversion, hash construction/update, checksum text conversion, and garbage collection. Optimized/inlined code is sometimes attributed to its `fetch` caller, so the report's `unpackManifest`-descendant samples are **not** a complete accounting of decoder CPU. Coarse stages are more useful for the decompression-versus-entry-loop distinction. Profiler timings must not be substituted for the comparison above, which ran without CPU profiling.

## Parallel and codec experiments

See [the async experiments](async-decoder-experiments.md) for native async decompression, `Promise.all`, Web Crypto hashing, runtime support, memory findings, and rejected approaches. The reusable synchronous hash buffer tested there is now implemented in the final decoder; its benefit was then verified by the full comparison above. No async decoder API or Worker-thread dependency was added.

| Experiment                                         | Finding / decision                                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Single-shot `crypto.hash`                          | Workerd implements it through the same streaming hash path; removed the extra abstraction. [Initial report](../bench/results/decoder-profile-initial.json) records this rejected candidate, not the final decoder. |
| Reader/path optimizations without hash scratch     | Useful but smaller gains; retained as an intermediate [comparison](../bench/results/decoder-comparison.json).                                                                                                      |
| Force Brotli/Zstandard for pure delta RSA metadata | Neither shrank the block: packets grew by 8 / 69 bytes. No reason to replace the existing automatic raw choice. [Stage/codec evidence](../bench/results/decoder-profile-stages.json).                              |
| Skip metadata compression for mixed RSA v3         | 2,644,803 → 2,781,105 bytes (+5.15%); optimized warm median 23 → 15 ms against Brotli. This is a measured size/latency tradeoff, not a default change.                                                             |

The mixed-path tradeoff is available through the existing `compression.metadata: "none"` option. It does not imply a benefit for uniform delta manifests, whose automatic metadata codec is already `none`. The library's automatic codec selection still minimizes framed byte size, not estimated decode latency.

## Refreshed Worker correctness and memory

The standard [full suite](../bench/results/suite-decoder-optimized.json) and independent [memory rerun](../bench/results/memory-decoder-optimized.json) both completed successfully on the final source. Eight synthetic workloads passed field-for-field verification, and all 126 malformed-packet cases were rejected as expected. The largest observed same-sample accounting was **87,363,752 bytes (87.4 MB)**; no phase crossed the 96 MiB diagnostic threshold. No forced GC was used.

Separate differential checks against the baseline verified 400 byte-identical synthetic packets, 3,600 matching string-limit outcomes, and 8,000 matching outcomes for corrupted packets with recalculated integrity hashes. The complete suite includes 365 tests, including interruption/cleanup checks for the benchmark tools. Library coverage is 99.8% of lines, 98.72% of branches, and 100% of functions.

A fresh full-corpus run also verified all 11,234,253 entries and all 226,847 version records locally, with no exclusions or raised limits. Every four-field tuple matched exactly, and aggregate packed bytes remained 864,721,162. The [public aggregate report](corpus-verification-results.json) identifies the final compiled library fingerprint; raw customer data and per-version reports remain private. This is correctness evidence, not a production-data performance benchmark.

The table below is from the independent memory rerun, in decimal MB. Accounting is the same-sample sum of CDP used heap, backing storage, and embedder heap. The fixture/encoding baseline is included.

| 10,000-row scenario | Paused decode checkpoints | Two retained outputs | Two concurrent requests | Eight requests, one admitted | Twenty sequential admitted requests |
| ------------------- | ------------------------: | -------------------: | ----------------------: | ---------------------------: | ----------------------------------: |
| SHA-256             |                      27.2 |                 25.7 |                    30.5 |                         26.2 |                                54.7 |
| RSA v3              |                      68.9 |                 66.6 |                    80.7 |                         47.3 |                                87.0 |
| Long paths          |                      67.1 |                 62.0 |                    77.0 |                         50.2 |                                87.4 |

Each eight-request admission test returned one successful decode and seven HTTP 429 responses. This is a benchmark example of caller-level admission control, not a new limiter inside the library.

The full suite's single-run encrypted timings were 26/28 ms first decode and 20.5/23 ms warm median for RSA v2/v3. Use the paired comparison above to attribute improvements; this suite's timings include concurrent memory sampling and fixture encoding before the first decode. Its lower observed values are not a new production target.

The refreshed Worker bundle SHA-256 is `fbd11cb3a4d048aabf575aec4c42d0c04bd1bd92e492e7db183b56674932886b`. Both runs use the unchanged lifecycle runner fingerprint `692ddcf626adee59a13cb357272d698d64d2589e7e2d5d2ee7dca7f1c56a4283`.

These observations do **not** establish memory safety for a complete `pg` fetch → decode → HTTP serialization pipeline, unlimited concurrent requests, or a large surrounding application. Sampling can miss short peaks and native allocations; allocated heap capacity and process RSS are separate metrics, not interchangeable with used isolate accounting. Some individual peaks are higher than historical runs despite fewer temporary allocations because GC timing and preparation history vary. The [earlier failing unguarded stress test](../bench/results/stress-unsafe.json) remains valid warning evidence and was not rerun or reclassified as passing.

## Reproduce

Run from the repository with its installed dependencies; the runner uses Bun only to bundle source and Node to drive Wrangler. No Worker is deployed, and no customer data is loaded.

```sh
node bench/run-decoder-comparison.mjs compare
COMPARE_CASES=rsa-v3-delta node bench/run-decoder-comparison.mjs profile
```

`COMPARE_CASES`, `COMPARE_ROUNDS`, `COMPARE_SAMPLES`, `COMPARE_PROFILE_ITERATIONS`, `COMPARE_PORT`, and `COMPARE_INSPECTOR_PORT` bound the run. `BASELINE_REF` defaults to the commit above. Each run snapshots both source trees before measurement. Runtime startup, HTTP/inspector operations, and shutdown are bounded; process exit and released ports are confirmed before the next isolate. Failed measurements make the command fail and remain marked in its report.

The final comparison selected all ordinary scenarios plus the mixed/Brotli and mixed/raw cases. The default command additionally repeats the three pure-delta metadata codec variants; these were already measured in the intermediate comparison. Profile reports' `rounds` metadata was corrected to one (the actual single profiling round); raw timings and profiles were not changed.
