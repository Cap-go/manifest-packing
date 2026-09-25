# Local full-corpus verification

The verifier runs the built JavaScript package against every manifest in a local
PostgreSQL archive. It makes no production database or network requests. Source archives,
SQLite imports, identifiers, filenames, paths, checksums, and checkpoints remain
private. Only the aggregate result belongs in this repository.

Node.js 24 is recommended. Node 22.15 is also supported when TypeScript stripping
is explicitly enabled; the package commands below supply that flag. Both runtimes
have been checked against a synthetic import and full round trip, including big
integers. The recorded production-corpus pass used Node 24. Build the package first:

```sh
bun install
bun run build
node --version
```

These scripts import `dist/index.js`, so the corpus pass validates the JavaScript
that will be shipped. They do not change operational limits or skip records that
the package rejects.

## Prepare the local input

Obtain the expected SHA-256 fingerprint from the archive's trusted local delivery
record. All paths below are examples. Keep the actual archive and private output
directory outside this public checkout. The importer refuses an existing
`corpus.sqlite` and streams PostgreSQL text COPY data with bounded buffering.
It decodes COPY escapes before retaining exact UTF-8 field bytes and uses SQLite
integers for lossless file sizes.

```sh
bun run ingest:corpus \
  --dump /private/local-data/manifest-data.dump \
  --expected-dump-sha256 EXPECTED_SHA256 \
  --private-directory /private/local-data/manifest-corpus \
  --pg-restore /absolute/path/to/pg_restore
```

The archive must contain `public.manifest`, `public.app_versions`, and
`public.apps`. The importer saves `corpus.sqlite`, `ingest.json`, and private
`pg-restore.stderr` in the selected directory. It records completion only after
the entire restore stream succeeds, all three tables are present, and indexing
finishes. A second archive hash detects source changes during import. Failed
imports remain incomplete; rerun into a fresh private directory.

The existing research SQLite import can also be reused read-only. Its required
schema is `manifest(version, ordinal, name BLOB, path BLOB, hash BLOB, size)`,
`versions(id, metadata JSON text)`, `apps(id, owner_org)`, and `state(key, value)`.
The `by_version` index covers `(version, ordinal)`. The state must include
`complete=true` and `manifest_rows`. Its adjacent `ingest.json` must include
`status=complete`, `dump_sha256`, `dump_bytes`, and `counts` for `manifest`,
`app_versions`, and `apps`. Version metadata preserves `name`, `app_id`,
`owner_org`, and `session_key`. The verifier checks this provenance against the
actual archive rather than trusting a cache merely because it exists.

## Verify every version

```sh
bun run verify:corpus \
  --dump /private/local-data/manifest-data.dump \
  --expected-dump-sha256 EXPECTED_SHA256 \
  --sqlite /private/local-data/manifest-corpus/corpus.sqlite \
  --ingest-metadata /private/local-data/manifest-corpus/ingest.json \
  --private-directory /private/local-data/manifest-verification \
  --workers 2 \
  --report docs/corpus-verification-results.json
```

Before packing, the verifier hashes the archive and SQLite file, validates import
completion and table counts, checks that COPY ordinals cover exactly `1..N`, and
rejects orphan manifests without version metadata. It requires an empty SQLite
write-ahead log and verifies the database fingerprint again after the run.
Each worker holds one complete manifest at a time, with SQLite read-only and a
bounded page cache.

Each version is packed with the default codec selection and original version
context, then unpacked and checked against the original four fields:

- `file_name`, `s3_path`, and `file_hash` must match the source UTF-8 bytes exactly.
- `file_size` must match as an integer, including values outside JavaScript's
  safe number range.
- Output follows stable UTF-8 byte ordering of filenames. Equal names retain
  source COPY order; duplicate entries are retained and checked individually.
- Entry counts, summed file sizes, and SHA-256 payload hashes must match.

The source and decoded tuples also feed independently constructed, length-delimited
digest chains in each private checkpoint. A final row-count and version-count
comparison proves that the worker partition processed every imported manifest.
Every version record without manifest rows also runs its own empty-manifest round
trip with the original version context. Nonempty and empty versions are counted
separately and checked against the source totals.

Progress messages contain counts only. Failure messages contain fixed error
codes, never source values. The failing version ID is saved only in a private
failure record to support local diagnosis. A failed row stops the run. No sample,
exclusion list, limit override, normalization, or repair is applied to obtain a
passing result.

## Resume and preserve evidence

Workers checkpoint every 100 versions. Repeat the same command with
`--resume true` to continue an interrupted run. A checkpoint is accepted only when
the archive, SQLite file, built package, verifier scripts, Node version, and worker
count match its fingerprint. Incomplete batches are checked again. The archive and
SQLite fingerprints and tuple digest chains are stored only in
`verification-private.json` and the private checkpoints.

The optional `--report` file contains aggregate counts, byte totals, elapsed time,
the public built-library fingerprint, runtime version, and pass/fail checks.
It contains no source identifiers, source fingerprints, filenames, paths, or
manifest payloads. Review that file before committing it. The package's npm file
allowlist excludes scripts, research evidence, and private corpus material. The
elapsed time is operational evidence from this run, not an isolated performance
benchmark.

For a reproducible release claim, start from the intended built commit, run without
`--resume true`, retain the private evidence locally, and commit only the aggregate
report. If the built JavaScript changes during a run, final verification fails and
the corpus must be verified against the new build.
