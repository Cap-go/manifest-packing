<!-- cspell:ignore microbenchmark EPERM webcrypto -->

# Async decompression and hashing probes

## Outcome

`Promise.all` does not provide parallel native decompression in the tested
Cloudflare Worker runtime. No async decoder API was added. A separate hashing
microbenchmark found that reusing a small input buffer improved synchronous
hashing across all three checksum representations. It matched or beat the
WebCrypto variants without requiring an async decoder API. These are isolated
hashing measurements, not a full-decoder speedup claim.

| Question                                           | Evidence / consequence                                                                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can `node:worker_threads.Worker` run the work?     | Constructing it throws `ERR_METHOD_NOT_IMPLEMENTED` in local workerd.                                                                                                                                    |
| Does async zlib use another CPU thread?            | Workerd's native implementation invokes `context()->work()` inline for both variants; the async variant adds callback handling.                                                                          |
| Can service bindings act as a thread pool?         | Cloudflare documents that both Workers normally run on the same thread. There is no demonstrated CPU parallelism here.                                                                                   |
| Does async zlib expose consumed input?             | With `info: true`, both Brotli and Zstandard returned the correct `engine.bytesWritten`. Adding one trailing byte left that byte unconsumed, allowing the existing exact-consumption guard to reject it. |
| Can validation be moved after starting async work? | No. Resource and framing checks must still run before native decompression. This probe is not a replacement decoder and does not relax the library's validation.                                         |

Sources: [Worker threading stub](https://github.com/cloudflare/workerd/blob/main/src/node/worker_threads.ts),
[native zlib implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/node/zlib-util.c%2B%2B),
[service binding execution](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/),
[Cloudflare Node module compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).
The sources describe the current implementation, not a promise that runtime
behavior will never change.

## Hashing microbenchmark

Local Wrangler **4.140.0**, workerd **1.20260923.1**, Node **22.15.0**, compatibility
date **2026-09-25**, `nodejs_compat`. Every fixture is synthetic. Each measurement
hashes 10,000 unique checksum strings with SHA-256 and returns lowercase
hexadecimal, as required when reconstructing delta object paths. This hashes
checksum text; it does not decrypt the checksum.

| Input text length          | `createHash` text | `crypto.hash` text | WebCrypto sequential | WebCrypto batches of 32 | `createHash` reusable buffer |
| -------------------------- | ----------------: | -----------------: | -------------------: | ----------------------: | ---------------------------: |
| 64 characters: SHA-256 hex |             22 ms |              19 ms |                22 ms |                   23 ms |                        14 ms |
| 344 characters: RSA base64 |             23 ms |              23 ms |                21 ms |                   19 ms |                        16 ms |
| 512 characters: RSA hex    |             25 ms |              25 ms |                18 ms |                   17 ms |                        17 ms |

- Fresh local runtime per character-length/method pair; six measured requests,
  first two excluded as warmup. Four warm observations per cell are a small
  sample, not production latency percentiles.
- Preparation and exact output comparisons are outside the timed interval.
  WebCrypto timing includes input UTF-8 encoding and output conversion to hex.
- At most 32 digest promises are active. There is no 10,000-promise fan-out.
- All 900,000 generated digest results matched the expected strings exactly.
- CDP was sampled every 5 ms without forced GC. Only six or seven samples were
  delivered per phase, so these observations do not bound intra-request peaks
  or native allocation. Maximum observed same-sample
  `usedSize + backingStorageSize + embedderHeapUsedSize` was **41,133,502 bytes**.
- The 512-character sequential and batch results are close: the result does not
  demonstrate CPU parallelism. API overhead/implementation differences can
  explain a gain without parallel execution.

The reusable-buffer variant allocates one 512-byte scratch buffer and a view
matching the checksum text length before timing. Each iteration writes the
ASCII checksum text into that buffer and passes the view to `createHash.update`.
It avoids creating a fresh buffer from the checksum string for every entry.
Its three phases peaked at **23,430,450 bytes** in the same sampled accounting.
The isolated gain was 7–8 ms per 10,000 entries compared with the initial string
baseline. This is the preferred candidate for an end-to-end decoder experiment:
no promise lifetime or async public API is needed. A production implementation
must still bound the scratch allocation and preserve arbitrary literal hash text.

Evidence: `bench/results/async-hash.json` contains the twelve initial phases;
`bench/results/async-hash-scratch.json` contains the three scratch-buffer phases.

## Decompression pilot

These blocks come from the existing synthetic 10,000-entry RSA-v3 fixture with
mixed path modes and prefix-coded filenames. Node compresses the same raw
filename/metadata blocks; the Worker verifies decoded lengths, consumed input,
and SHA-256 digests. This measures only decompression, not path reconstruction,
row materialization, payload validation, PostgreSQL fetching, or JSON output.

| Codec / method                     | Warm median | Largest warm observation | Maximum sampled accounting |
| ---------------------------------- | ----------: | -----------------------: | -------------------------: |
| Brotli synchronous                 |       18 ms |                   147 ms |           80,564,085 bytes |
| Brotli async sequential            |       10 ms |                   108 ms |           80,593,933 bytes |
| Brotli async `Promise.all`         |        9 ms |                    23 ms |           80,595,021 bytes |
| Zstandard synchronous, partial run |        2 ms |                    50 ms |           67,665,408 bytes |

Fifteen requests per method, first three excluded. With twelve warm observations,
the recorded empirical p95 is the largest sample. The large outliers and
between-runtime variation make the apparent async advantage exploratory,
not a proven or stable latency improvement. Async implementations may have
different stream/buffer overhead despite performing native CPU work inline.

The first combined 90-pair pilot exceeded the **128,000,000-byte sampled guard**.
It was rejected; its detailed samples were not saved. The revised probe uses a
fresh runtime for each codec/method. During cleanup after the Zstandard sync
phase, the process-group check returned `EPERM`, aborting the coordinator. A
separate process/port inspection found no remaining probe process and confirmed
both ports were free, but the phase is still recorded as partial rather than a
clean completed run. The remaining two Zstandard async phases were not run.
No aggregate decompression pass is claimed.

## Reproduction

```sh
# Synthetic hashing comparisons, fresh runtime per method and input length.
node bench/async-decompression.mjs hash

# Synchronous reusable input-buffer candidate.
node bench/async-decompression.mjs hash-scratch

# Synthetic decompression comparisons, fresh runtime per method and codec.
node bench/async-decompression.mjs

# One bounded diagnostic phase.
node bench/async-decompression.mjs 512 webcrypto-batch32
node bench/async-decompression.mjs brotli async-all
```

The experiment uses localhost ports 8797 and 9247, rejects occupied ports,
disables Wrangler telemetry, has bounded startup/HTTP/inspector/shutdown waits,
and waits for the original child process group and ports to close before the
next phase. It never deploys a Worker or uses customer data. These files are
benchmark-only; no production library dependency or API changed.
