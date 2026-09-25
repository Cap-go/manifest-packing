# `@capgo/manifest-packing`

TypeScript types and APIs for Capgo's versioned binary manifest format.

This first release establishes the public contract. Packing and unpacking are
intentionally not implemented yet. Both functions throw `ManifestPackingError`
with the `NOT_IMPLEMENTED` code. `packManifest` first enforces the 10,000-entry
limit and reports `TOO_MANY_ENTRIES` when it is exceeded.

## Install

```sh
npm install @capgo/manifest-packing
```

## API

```ts
import {
  MANIFEST_FORMAT_VERSION,
  ManifestPackingError,
  ManifestPackingErrorCode,
  packManifest,
  unpackManifest,
  type ManifestEntry,
  type PackedManifest
} from "@capgo/manifest-packing";

const entries: ManifestEntry[] = [
  {
    id: 1,
    app_version_id: 42,
    file_name: "index.html",
    s3_path: "apps/example/index.html",
    file_hash: "sha256-example",
    file_size: 1024
  }
];

try {
  const packed: PackedManifest = packManifest(entries);

  unpackManifest({
    format_version: packed.format_version,
    entry_count: packed.entry_count,
    payload_hash: packed.payload_hash,
    manifest: packed.manifest
  });
} catch (error) {
  if (error instanceof ManifestPackingError) {
    console.error(error.code, error.message);
  }
}

console.log(MANIFEST_FORMAT_VERSION); // 1
```

`payload_hash` and `manifest` use `Uint8Array`, the portable binary type shared
by browsers and modern JavaScript runtimes. Node.js `Buffer` values are
compatible because `Buffer` extends `Uint8Array`.

The format version is the exported `MANIFEST_FORMAT_VERSION` constant and is
independent of the npm package version.

## Development

Install [Bun](https://bun.sh/), then run:

```sh
bun install --frozen-lockfile
bun run check
```

The full check runs formatting, oxlint, TypeScript, spelling, unit tests with
coverage thresholds, the production build, and package validation.

## Releases

The release flow follows Capgo's commit-and-tag model:

1. A push to `main` runs the complete check workflow.
2. After it passes, Capgo's standard-version tool creates a release commit and
   matching semantic version tag. With no existing version tag, it creates the
   initial `0.0.1` release without incrementing `package.json`.
3. The tag workflow verifies the tag and package versions, runs all checks
   again, publishes the package to npm with provenance, and creates a GitHub
   release.

Subsequent versions follow Conventional Commits: fixes produce patch releases,
features produce minor releases, and breaking changes produce major releases.

Repository configuration requires a `PERSONAL_ACCESS_TOKEN` Actions secret to
push the release commit and tag, plus an `NPM_TOKEN` secret allowed to publish
the `@capgo/manifest-packing` package.

## License

GNU Affero General Public License v3.0 only. See [LICENSE](./LICENSE).
