import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { packManifest, unpackManifest } from "../src/index.js";

it.each([
  ["sha256", "ab".repeat(32)],
  ["rsa-base64", Buffer.alloc(256, 0xab).toString("base64")],
  ["rsa-hex", "ab".repeat(256)]
])("enforces reconstructed %s hash string limits", (_kind, file_hash) => {
  const entry = { file_name: "a", s3_path: "b", file_hash, file_size: 0 };
  const packet = packManifest([entry]);
  for (const maxStringBytes of [8, file_hash.length - 1]) {
    expect(() =>
      unpackManifest(packet, { limits: { maxStringBytes } })
    ).toThrow(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
  }
  expect(
    unpackManifest(packet, { limits: { maxStringBytes: file_hash.length } })
  ).toEqual([entry]);
});
