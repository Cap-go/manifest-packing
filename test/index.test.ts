import { describe, expect, it } from "vitest";

import {
  MANIFEST_FORMAT_VERSION,
  MAX_MANIFEST_ENTRIES,
  ManifestPackingError,
  ManifestPackingErrorCode,
  packManifest,
  unpackManifest,
  type ManifestEntry
} from "../src/index.js";

const entry: ManifestEntry = {
  id: 1,
  app_version_id: 2,
  file_name: "index.html",
  s3_path: "apps/example/index.html",
  file_hash: "sha256-example",
  file_size: 42
};

describe("manifest packing foundation", () => {
  it("exports format version 1", () => {
    expect(MANIFEST_FORMAT_VERSION).toBe(1);
  });

  it("rejects more than 10,000 entries with the library error type", () => {
    const entries = Array.from(
      { length: MAX_MANIFEST_ENTRIES + 1 },
      () => entry
    );

    expect(() => packManifest(entries)).toThrowError(
      new ManifestPackingError(
        ManifestPackingErrorCode.TooManyEntries,
        `Manifest entries cannot exceed ${MAX_MANIFEST_ENTRIES}`
      )
    );
  });

  it("accepts exactly 10,000 entries before reporting unimplemented packing", () => {
    const entries = Array.from({ length: MAX_MANIFEST_ENTRIES }, () => entry);

    expect(() => packManifest(entries)).toThrowError(
      new ManifestPackingError(
        ManifestPackingErrorCode.NotImplemented,
        "Manifest packing is not yet implemented"
      )
    );
  });

  it("reports unimplemented unpacking with the library error type", () => {
    expect(() =>
      unpackManifest({
        format_version: MANIFEST_FORMAT_VERSION,
        entry_count: 0,
        payload_hash: new Uint8Array(32),
        manifest: new Uint8Array()
      })
    ).toThrowError(
      new ManifestPackingError(
        ManifestPackingErrorCode.NotImplemented,
        "Manifest unpacking is not yet implemented"
      )
    );
  });
});
