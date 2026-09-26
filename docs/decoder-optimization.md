# Numeric-reader ablation

The measured optimization has modest, workload-dependent effects. This experiment does **not** establish a fastest decoder or a memory ceiling.

`bench/decoder-optimization.ts` runs the complete current `unpackManifest` against identical prepacked synthetic tuples with two size readers. The current reader returns safe integers as numbers and promotes larger values to bigint. The comparison reader uses the earlier byte parsing algorithm and returns bigint for every size. Only `Reader.prototype.size` changes inside this isolated local Worker; the original method is restored between trials and on failure. Production source files are unchanged.

This is a controlled reader ablation, not a historical-release comparison. In the comparison, safe sizes remain bigint in the returned rows, whereas the current reader returns numbers. The historical full decoder also converted safe output values to numbers; that conversion is deliberately **not** added as a timed wrapper here. Before timing, both outputs are checked against the exact four source fields with integer values converted to decimal strings. Consequently, this comparison slightly favors the baseline by omitting historical output normalization.

## Recorded run

Local execution on 2026-09-25 used Wrangler 4.140.0, workerd 1.20260923.1, compatibility date 2026-09-25, `nodejs_compat`, Node 22.15.0 as the driver, and an Apple M4 Pro / macOS arm64 host. No deployment, network corpus, or customer data was used. Other agents paused heavy measurements during these trials.

Each scenario ran three rounds with 13 paired samples per round, alternating which reader ran first. Both readers were warmed, and correctness checks, packing, HTTP transport, and inspector requests were outside timing. The table shows medians pooled over 39 samples per reader. Milliseconds are per complete decode, including integrity checking, decompression, validation, allocation, and ordinary garbage collection.

| Synthetic scenario       | Entries | Packet bytes | Current reader, ms | Always-bigint reader, ms | Round median speedup range |
| ------------------------ | ------: | -----------: | -----------------: | -----------------------: | -------------------------: |
| Small legacy / SHA-256   |      20 |          869 |              0.040 |                    0.040 |               1.000–1.176× |
| Large legacy / SHA-256   |  10,000 |      361,120 |              8.300 |                    8.500 |               1.000–1.036× |
| Unicode delta / SHA-256  |   1,000 |       36,447 |              4.600 |                    4.550 |               0.930–1.037× |
| Mixed paths / RSA Base64 |   1,000 |      265,059 |              2.950 |                    2.950 |               1.000–1.056× |

The large legacy case suggests a small benefit; the other pooled medians are equal or slightly favor the comparison. Variation between rounds and the local clock's resolution prevent a stronger latency conclusion. The reader fast path preserves exact integer behavior, but these measurements do not justify a broad percentage-speedup claim.

## Failed synchronous allocation stress

The recorded run above used 400 / 10 / 40 / 40 consecutive decodes per sample and 20 warmups per reader, with all 13 pairs inside one synchronous request. Inspector snapshots after requests reached **485,253,309 bytes** for `usedSize + backingStorageSize` (approximately 463 MiB), including a snapshot with 432,987,333 backing-storage bytes. Later automatic collection reduced those counters sharply. This is a **failed allocation-stress result**, not an acceptable-memory measurement. Post-request snapshots are not peak measurements; they also are not the platform's exact memory accounting.

The committed experiment reduces batches to 80 / 2 / 8 / 8, uses four initial warmups, and yields to the event loop outside each measured sample. It never forces garbage collection. These changes bound work per synchronous batch; they do not guarantee reclamation or a platform memory ceiling. Any observed retained snapshot above the primary monitor's conservative 128,000,000-byte ceiling must still be reported as a failed stress result. The table above remains explicitly associated with the original synchronous run and must not be attributed to the revised harness.

A final single-round check of this revised harness used live inspector snapshots approximately every 30 ms, without forced collection. The largest sampled `usedSize + backingStorageSize` was 60,508,066 bytes (57.7 MiB). All exact tuple checks passed. This is sampled local evidence, not a continuous peak guarantee. A final source validation check for fixed-width hash string limits had also been added before this check; the earlier table predates that small change.

| Revised bounded run | Current reader median, ms | Always-bigint reader median, ms | Maximum sampled accounting, bytes |
| ------------------- | ------------------------: | ------------------------------: | --------------------------------: |
| Small               |                     0.025 |                          0.0375 |                        39,725,542 |
| Large               |                     7.500 |                           7.500 |                        40,421,392 |
| Unicode             |                     4.125 |                           4.000 |                        55,042,921 |
| RSA                 |                     2.250 |                           2.250 |                        60,508,066 |

Shorter batches increase the relative effect of clock resolution. This bounded check preserves exact values and again shows no consistent full-decoder speedup across all scenarios.

## Reproduction

Run from the repository root, on ports separate from the primary benchmark:

```sh
bunx wrangler dev bench/decoder-optimization.ts --local --ip 127.0.0.1 --port 8793 --inspector-ip 127.0.0.1 --inspector-port 9235 --show-interactive-dev-session=false
```

Request `http://127.0.0.1:8793/health`, connect a DevTools/CDP client to the target listed by `http://127.0.0.1:9235/json/list`, then request `/run?case=small`, `/run?case=large`, `/run?case=unicode`, or `/run?case=rsa`. Keep the inspector attached for timing; the Worker rejects zero-duration samples. Each response includes all 13 samples, medians, tuple correctness, and packet size. Collect `Runtime.getHeapUsage` snapshots outside timing and retain failures; do not force collection to turn an unsafe run into a passing memory claim. Stop this local Worker when finished.
