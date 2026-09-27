# `@capgo/manifest-packing`

Lossless TypeScript encoding and decoding of Capgo manifests, using binary
**protocol version 1**. Each app version is independently readable. The encoder
shares path components, packs hexadecimal/Base64 hashes into bytes, prefix-codes
sorted filenames, and independently compresses filenames and entry metadata.

Supported runtimes: Node.js **22.15 or newer**, and Cloudflare Workers with
`nodejs_compat`. Compression and SHA-256 use native `node:zlib` and `node:crypto`.
No runtime package dependencies or external compression dictionary are required.

```sh
npm install @capgo/manifest-packing
```

## Usage

```ts
import {
  packManifest,
  packSizeManifest,
  unpackManifest,
  ManifestPackingError,
  type ManifestEntry
} from "@capgo/manifest-packing";

const entries: ManifestEntry[] = [
  {
    file_name: "assets/main.js",
    s3_path: "orgs/example-org/apps/example.app/v1/assets/main.js",
    file_hash: "ab".repeat(32),
    file_size: 1024
  }
];

try {
  const packed = packManifest(entries, {
    context: {
      org_id: "example-org",
      app_id: "example.app",
      version_name: "v1"
    }
  });

  // Store both packets and hashes with the immutable app version.
  const decoded = unpackManifest(packed);
  console.log(decoded[0]?.file_name);

  // If sizes are not checked yet, omit the sidecar. After receipt validation,
  // attach it without rewriting the main packet:
  const pending = packManifest(entries, { encodeSize: false });
  const checkedSizes = packSizeManifest(pending, entries);
  const completed = unpackManifest({ ...pending, ...checkedSizes });
} catch (error) {
  if (error instanceof ManifestPackingError) {
    console.error(error.code, error.message);
  } else {
    throw error;
  }
}
```

All three APIs are synchronous. `packManifest` returns `format_version`,
`entry_count`, `total_file_size`, `payload_hash` (32-byte SHA-256), `manifest`
(`Uint8Array`), plus `manifest_size` and `manifest_size_payload_hash` when
`encodeSize` is true (the default). Both size fields are `null` otherwise.
`total_file_size` is also `null` when `encodeSize` is false. Node `Buffer` inputs
are also accepted. `unpackManifest` verifies both packet hashes, embedded
versions, entry counts, the main-hash binding, and corresponding entry tags.
Pass `total_file_size` to verify the sidecar sum when a size packet is present.

The four decoded fields are `file_name`, `s3_path`, `file_hash`, and `file_size`.
Without a size packet, every decoded `file_size` is `null`. The codec does not
verify R2 size receipts; callers must do that before creating/storing a sidecar.
Database row `id` and `app_version_id` are optional input fields and are not
serialized. If version IDs are supplied, they must agree. The caller associates
the packet with its owning immutable version and enforces authorization.

Whole entries are stably sorted by exact UTF-8 filename bytes. Duplicate names and
duplicate tuples remain present, with equal-name entries retaining input order.
No Unicode normalization, hash normalization, deduplication, or path repair occurs.
Decoded sizes use `number` through `Number.MAX_SAFE_INTEGER`, then `bigint` through
`2^63 - 1`; the total has the same representation. Negative, fractional,
unsafe-number, and overflowing file sizes are rejected. Null sizes are accepted
only with `encodeSize: false`. Use `bigint` for large
integers; standard JSON needs a custom serializer for those values.

If `context` is omitted, the encoder infers shared components from recognizable
source paths. A reconstructed path is used only when it exactly reproduces the
original. All other valid relative paths are stored literally. Explicit version
context avoids inference and is recommended when already available.

## Encoding choices

| Option                  | Default  | Alternatives                      |
| ----------------------- | -------- | --------------------------------- |
| `filenameTransform`     | `"auto"` | `"raw"`, `"prefix"`               |
| `encodeSize`            | `true`   | `false` to defer the size sidecar |
| `compression.filenames` | `"auto"` | `"none"`, `"brotli"`, `"zstd"`    |
| `compression.metadata`  | `"auto"` | `"none"`, `"brotli"`, `"zstd"`    |

Automatic filenames compare raw/prefix transforms with uncompressed/Brotli quality
11 blocks. Automatic metadata compares uncompressed, Brotli quality 6, and Zstandard
level 3. Selection includes the complete block framing. Ties prefer raw filenames,
then lower compression IDs: none, Brotli, Zstandard. Explicit codec selection
forces that codec for nonempty blocks; empty blocks are stored uncompressed.
Compression levels affect encoder effort, not the binary protocol.

Automatic selection skips a codec if the runtime cannot encode that candidate.
For example, workerd `1.20260923.1` has an
[upstream Zstandard encoder bug](https://github.com/cloudflare/workerd/issues/6769)
for larger incompressible inputs. Automatic encoding remains usable with
Brotli/raw blocks; explicit `"zstd"` reports `COMPRESSION_ERROR` on that affected
path. The local benchmark also checks Worker Zstandard decoding with packets
produced by Node.

The decoder checks exact stream consumption and output lengths. It rejects
truncation, appended/concatenated streams, nonminimal VarUInts, unsupported codecs,
invalid UTF-8, nonmaximal filename prefixes, invalid relative paths, and oversized
resource declarations. Noncanonical historical hash text has an exact literal
representation. See [the wire format](docs/protocol.md).

## Resource limits and Workers

Both APIs accept `limits` overrides. Defaults are deliberately below the platform
limit and are enforced before large allocations or retained decoded expansion.

| Limit             |                                  Default |
| ----------------- | ---------------------------------------: |
| `maxEntries`      |                                   10,000 |
| `maxPacketBytes`  |                                   16 MiB |
| `maxBlockBytes`   |     16 MiB per uncompressed/stored block |
| `maxStringBytes`  |   1 MiB per string or reconstructed path |
| `maxDecodedBytes` |     32 MiB of reconstructed UTF-8 fields |
| `maxMemoryBytes`  | 96 MiB conservative operation accounting |

The 10,000-entry default is an operational bound, not a 10,000-entry wire limit.
It can be raised explicitly up to 1,000,000 while all byte and memory bounds still
apply. Smaller limits can be useful for a shared Worker. See the exported
`DEFAULT_MANIFEST_LIMITS` and `ManifestLimits` types.

Cloudflare's [128 MB memory limit](https://developers.cloudflare.com/workers/platform/limits/#memory)
applies to the entire isolate, including concurrent requests and retained data.
The library budget estimates its operation; it cannot measure or reserve memory
held elsewhere in the application. Bound upstream reads and keep an admission
reservation while using or caching decoded output. The local benchmark includes
a conservative admission example and a monitor for actual inspector measurements.
Its sampled peaks and process RSS have distinct meanings; see
[memory methodology](docs/benchmark-methodology.md).

The stress tests deliberately demonstrate unsafe usage too: retaining many large
decoded manifests or running long synchronous decode loops can exceed the
platform ceiling before garbage collection. Returning to the event loop is not
a guarantee of reclamation. Apply admission and retained-output limits in the
surrounding application; do not treat successful individual decodes as a global
memory guarantee.

Use an explicit compatibility date and Node compatibility in your Worker:

```jsonc
{
  "compatibility_date": "2026-09-25",
  "compatibility_flags": ["nodejs_compat"]
}
```

## Development and evidence

```sh
bun install --frozen-lockfile
bun run check
bun run bench
bun run bench:matrix
bun run bench:memory
```

The check command runs formatting, lint, type checking, spelling, unit tests with
coverage thresholds, the production build, and package validation. Worker
benchmarks launch Wrangler **locally**. They use deterministic synthetic data
included in `fixtures/`, record timing samples, check decoded content, and monitor
memory through the actual workerd inspector. They never deploy a Worker.

The private-corpus tools verify every version from a local PostgreSQL dump,
including exact bytes, duplicates, file sizes, and metadata. They emit only
aggregate evidence; no customer data is included in this repository or npm
package. See [full-corpus verification](docs/corpus-verification.md) for local
commands and provenance checks. Node.js 24 is recommended for these tools.
Node 22.15 is also tested; the package commands explicitly enable TypeScript
stripping instead of relying on a newer Node version's default.

Recorded evidence includes the [aggregate corpus result](docs/corpus-verification-results.json),
[local Worker results and codec matrix](docs/benchmark-results.md), the
[decoder allocation follow-up](docs/decoder-allocation-optimization.md), and a
[prior numeric-reader experiment](docs/decoder-optimization.md).
These measurements are workload-dependent, not a universal speedup or proof
that no faster implementation exists.

Protocol version 1 is independent of the npm package version. Existing protocol
0 decoders intentionally reject version 1 packets. Deploy a compatible decoder
before storing packets with `format_version = 1`.

## Releases

A push to `main` runs the complete check workflow. Capgo's standard-version tool
then creates a release commit and matching semantic version tag. The tag workflow
checks the package, stages it on npm with provenance, requests approval from
Capgo's npm stage automation, and creates a GitHub release.

Releases follow Conventional Commits. Repository configuration uses Capgo Actions
secrets: `PERSONAL_ACCESS_TOKEN` for release commits/tags, `NPM_TOKEN` for npm
staging, and `NPM_STAGE_DISPATCH_TOKEN` for the approval request.

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
