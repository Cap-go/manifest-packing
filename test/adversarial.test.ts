import { describe, expect, it } from "vitest";

import {
  ManifestPackingError,
  packManifest,
  unpackManifest,
  type ManifestEntry,
  type PackManifestOptions,
  type UnpackManifestInput,
  type UnpackManifestOptions
} from "../src/index.js";
import { adversarialPackets } from "../fixtures/adversarial.js";
import { syntheticBytes } from "../fixtures/synthetic.js";
import { bytes, packet, withDigest } from "../fixtures/wire.js";

const entry: ManifestEntry = {
  file_name: "a",
  s3_path: "p",
  file_hash: "x",
  file_size: 1
};

function captureError(action: () => unknown): ManifestPackingError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestPackingError);
    return error as ManifestPackingError;
  }
  throw new Error("Expected a ManifestPackingError");
}

describe("independently framed hostile packets", () => {
  it.each(adversarialPackets())(
    "rejects $name",
    ({ input, options, expectedCodes }) => {
      const error = captureError(() => unpackManifest(input, options));
      expect(expectedCodes).toContain(error.code);
    }
  );

  it("rejects every truncation of the golden packet with recomputed integrity", () => {
    const valid = packet();
    for (let length = 0; length < valid.manifest.length; length++) {
      captureError(() =>
        unpackManifest(withDigest(valid.manifest.subarray(0, length)))
      );
    }
  });

  it("rejects every single-bit packet mutation under its original digest", () => {
    const valid = packet();
    for (let index = 0; index < valid.manifest.length; index++) {
      for (let bit = 0; bit < 8; bit++) {
        const mutated = valid.manifest.slice();
        mutated[index] = mutated[index]! ^ (1 << bit);
        expect(
          captureError(() => unpackManifest({ ...valid, manifest: mutated }))
            .code
        ).toBe("INTEGRITY_MISMATCH");
      }
    }
  });

  it("bounds deterministic fuzz inputs and only exposes documented errors", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const fuzz = syntheticBytes(seed % 127, seed);
      const input = withDigest(bytes([0, 0, 1], fuzz));
      captureError(() => unpackManifest(input));
    }
  });

  it.each([undefined, null, {}, [], "packet", 7])(
    "rejects malformed outer input %#",
    (value) => {
      captureError(() =>
        unpackManifest(value as unknown as UnpackManifestInput)
      );
    }
  );

  it.each([
    { format_version: -1 },
    { format_version: 0.5 },
    { format_version: NaN },
    { entry_count: -1 },
    { entry_count: 0.5 },
    { entry_count: NaN },
    { payload_hash: new Uint8Array(31) },
    { payload_hash: new Uint8Array(33) },
    { payload_hash: [] },
    { manifest: [] },
    { manifest: null },
    { total_file_size: -1 },
    { total_file_size: NaN },
    { total_file_size: 1.5 },
    { total_file_size: Number.MAX_SAFE_INTEGER + 1 },
    { total_file_size: 1n << 63n }
  ])("rejects invalid metadata or buffer %#", (fields) => {
    captureError(() =>
      unpackManifest({
        ...packet(),
        ...fields
      } as unknown as UnpackManifestInput)
    );
  });
});

describe("source and option validation", () => {
  it.each([null, "options", 7, []])(
    "rejects malformed options %#",
    (options) => {
      expect(
        captureError(() =>
          packManifest([entry], options as unknown as PackManifestOptions)
        ).code
      ).toBe("INVALID_INPUT");
      expect(
        captureError(() =>
          unpackManifest(packet(), options as unknown as UnpackManifestOptions)
        ).code
      ).toBe("INVALID_INPUT");
    }
  );

  it.each([
    null,
    "private-looking-but-fake-id",
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    -1n
  ])(
    "rejects invalid optional version identity %# without exposing it",
    (id) => {
      const row = { ...entry, app_version_id: id } as unknown as ManifestEntry;
      for (const rows of [
        [row],
        [entry, row],
        [{ ...entry, app_version_id: 1 }, row]
      ]) {
        const error = captureError(() => packManifest(rows));
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.message).not.toContain("private-looking-but-fake-id");
      }
    }
  );

  it("rejects rows with different version identities", () => {
    expect(
      captureError(() =>
        packManifest([
          { ...entry, app_version_id: 1 },
          { ...entry, app_version_id: 2n }
        ])
      ).code
    ).toBe("INVALID_INPUT");
  });

  it.each(["org_id", "app_id", "version_name", "session_key"] as const)(
    "validates explicit %s context before reconstruction",
    (key) => {
      for (const value of [null, 7, {}, "\ud800", "\udfff"]) {
        const options = {
          context: { [key]: value }
        } as unknown as PackManifestOptions;
        expect(captureError(() => packManifest([entry], options)).code).toBe(
          "INVALID_INPUT"
        );
      }
    }
  );

  it.each([null, "context", 7, []])(
    "rejects malformed context objects %#",
    (context) => {
      expect(
        captureError(() =>
          packManifest([entry], { context } as unknown as PackManifestOptions)
        ).code
      ).toBe("INVALID_INPUT");
    }
  );

  it.each([
    null,
    -1,
    -1n,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    1n << 63n,
    "1",
    undefined
  ])("rejects invalid source size %#", (size) => {
    const error = captureError(() =>
      packManifest([{ ...entry, file_size: size } as unknown as ManifestEntry])
    );
    expect(error.code).toBe("INVALID_INPUT");
  });

  it("rejects a source size sum beyond signed 63-bit range", () => {
    captureError(() =>
      packManifest([
        { ...entry, file_size: (1n << 63n) - 1n },
        { ...entry, file_size: 1 }
      ])
    );
  });

  it.each([
    "",
    "/a",
    "\\a",
    "C:/a",
    "a\\b",
    "a\0b",
    ".",
    "..",
    "a/../b",
    "a/./b"
  ])("rejects unsafe source paths %j", (path) => {
    expect(
      captureError(() => packManifest([{ ...entry, file_name: path }])).code
    ).toBe("INVALID_INPUT");
    expect(
      captureError(() => packManifest([{ ...entry, s3_path: path }])).code
    ).toBe("INVALID_INPUT");
  });

  it.each(["\ud800", "\udfff", "a\ud800b"])(
    "rejects unpaired UTF-16 surrogates %j",
    (value) => {
      for (const key of ["file_name", "s3_path", "file_hash"] as const) {
        expect(
          captureError(() => packManifest([{ ...entry, [key]: value }])).code
        ).toBe("INVALID_INPUT");
      }
    }
  );

  it.each([null, undefined, 7, "entries", {}, [null], [{}]])(
    "rejects invalid rows %#",
    (input) => {
      captureError(() => packManifest(input as unknown as ManifestEntry[]));
    }
  );

  it.each([
    { filenameTransform: "unknown" },
    { fileSizeMode: "unknown" },
    { compression: { filenames: "unknown" } },
    { compression: { metadata: "unknown" } },
    { limits: { maxEntries: 0 } },
    { limits: { maxEntries: 1_000_001 } },
    { limits: { maxBlockBytes: -1 } },
    { limits: { maxPacketBytes: Infinity } },
    { limits: { maxStringBytes: 0.5 } },
    { limits: { maxMemoryBytes: NaN } },
    { limits: { maxDecodedBytes: 0 } }
  ])("rejects invalid packing options %#", (options) => {
    captureError(() =>
      packManifest([entry], options as unknown as PackManifestOptions)
    );
  });

  it.each([null, "limits", 7, []])(
    "rejects malformed resource limit objects %#",
    (limits) => {
      expect(
        captureError(() =>
          packManifest([entry], { limits } as unknown as PackManifestOptions)
        ).code
      ).toBe("INVALID_INPUT");
      expect(
        captureError(() =>
          unpackManifest(packet(), {
            limits
          } as unknown as UnpackManifestOptions)
        ).code
      ).toBe("INVALID_INPUT");
    }
  );

  it("rejects source fields over string, decoded, block, packet, and memory limits", () => {
    for (const key of [
      "maxStringBytes",
      "maxDecodedBytes",
      "maxBlockBytes",
      "maxPacketBytes",
      "maxMemoryBytes"
    ] as const) {
      const error = captureError(() =>
        packManifest([{ ...entry, file_name: "long-filename" }], {
          limits: { [key]: 1 }
        })
      );
      expect(error.code).toBe("RESOURCE_LIMIT");
    }
  });

  it("does not leak source values through error messages", () => {
    const sentinel = "private-looking-but-fake-sentinel";
    const error = captureError(() =>
      packManifest([{ ...entry, file_name: `../${sentinel}` }])
    );
    expect(error.message).not.toContain(sentinel);
  });
});
