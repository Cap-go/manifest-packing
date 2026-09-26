import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ManifestPackingError,
  packManifest,
  unpackManifest
} from "../src/index.js";
import { block, bytes, inspectPacket, packet } from "../fixtures/wire.js";

const runtime = vi.hoisted(() => ({
  mode: "native" as
    "native" | "compress-error" | "zstd-compress-error" | "decode-result",
  result: undefined as unknown
}));

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    brotliCompressSync: (
      ...args: Parameters<typeof actual.brotliCompressSync>
    ) => {
      if (runtime.mode === "compress-error")
        throw new Error("native-private-detail");
      return actual.brotliCompressSync(...args);
    },
    brotliDecompressSync: (
      ...args: Parameters<typeof actual.brotliDecompressSync>
    ) => {
      if (runtime.mode === "decode-result") return runtime.result;
      return actual.brotliDecompressSync(...args);
    },
    zstdCompressSync: (...args: Parameters<typeof actual.zstdCompressSync>) => {
      if (runtime.mode === "zstd-compress-error")
        throw new Error("native-private-detail");
      return actual.zstdCompressSync(...args);
    }
  };
});

afterEach(() => {
  runtime.mode = "native";
  runtime.result = undefined;
});

// The bytes are immaterial when the runtime response is controlled by this test.
const input = packet({ names: block(bytes([1, 2, 3]), 1, 2) });

describe("native runtime failure boundaries", () => {
  it.each([
    undefined,
    null,
    new Uint8Array([1, 97]),
    {},
    { buffer: [1, 97], engine: { bytesWritten: 3 } },
    { buffer: new Uint8Array([1, 97]) },
    { buffer: new Uint8Array([1, 97]), engine: null },
    { buffer: new Uint8Array([1, 97]), engine: {} },
    { buffer: new Uint8Array([1, 97]), engine: { bytesWritten: NaN } },
    { buffer: new Uint8Array([1, 97]), engine: { bytesWritten: 1.5 } }
  ])(
    "fails closed when the runtime cannot report trustworthy consumption %#",
    (result) => {
      runtime.mode = "decode-result";
      runtime.result = result;
      expect(() => unpackManifest(input)).toThrowError(
        expect.objectContaining({ code: "UNSUPPORTED_RUNTIME" })
      );
    }
  );

  it.each([
    { buffer: new Uint8Array([1, 97]), engine: { bytesWritten: 2 } },
    { buffer: new Uint8Array([1, 97]), engine: { bytesWritten: 4 } },
    { buffer: new Uint8Array([1, 97]), engine: { bytesWritten: -1 } },
    { buffer: new Uint8Array([1]), engine: { bytesWritten: 3 } },
    { buffer: new Uint8Array([1, 97, 0]), engine: { bytesWritten: 3 } }
  ])("rejects inaccurate native length or consumption %#", (result) => {
    runtime.mode = "decode-result";
    runtime.result = result;
    expect(() => unpackManifest(input)).toThrowError(
      expect.objectContaining({ code: "INVALID_PACKET" })
    );
  });

  it("wraps native compression errors without exposing native error details", () => {
    runtime.mode = "compress-error";
    let caught: unknown;
    try {
      packManifest(
        [{ file_name: "a", s3_path: "p", file_hash: "x", file_size: 1 }],
        {
          compression: { filenames: "brotli", metadata: "none" }
        }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManifestPackingError);
    expect(caught).toMatchObject({ code: "COMPRESSION_ERROR" });
    expect(String(caught)).not.toContain("native-private-detail");
  });

  it("keeps the raw candidate when automatic filename compression fails", () => {
    runtime.mode = "compress-error";
    const entry = {
      file_name: "a",
      s3_path: "p",
      file_hash: "x",
      file_size: 1
    };
    const packed = packManifest([entry], {
      compression: { filenames: "auto", metadata: "none" }
    });
    expect(inspectPacket(packed.manifest).blocks[0]!.codec).toBe(0);
    expect(unpackManifest(packed)).toEqual([entry]);
  });

  it("retains an already selected Brotli candidate when automatic Zstandard fails", () => {
    runtime.mode = "zstd-compress-error";
    const entry = {
      file_name: "a",
      s3_path: "p",
      file_hash: "x".repeat(512),
      file_size: 1
    };
    const packed = packManifest([entry], {
      compression: { filenames: "none", metadata: "auto" }
    });
    expect(inspectPacket(packed.manifest).blocks[1]!.codec).toBe(1);
    expect(unpackManifest(packed)).toEqual([entry]);
    expect(() =>
      packManifest([entry], {
        compression: { filenames: "none", metadata: "zstd" }
      })
    ).toThrowError(expect.objectContaining({ code: "COMPRESSION_ERROR" }));
  });
});
