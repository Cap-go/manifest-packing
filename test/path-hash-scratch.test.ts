import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as paths from "../src/paths.js";

describe("per-decode path hash scratch", () => {
  it("hashes only the current exact UTF-8 bytes across different lengths", () => {
    expect(paths.PathHasher).toBeTypeOf("function");
    const hasher = new paths.PathHasher();
    const values = [
      "a".repeat(512),
      "B".repeat(342) + "==",
      "c".repeat(64),
      "abc",
      "",
      "\uFEFFé/e\u0301/日本語/😀\0",
      "😀".repeat(128),
      "😀".repeat(129),
      "z".repeat(1024),
      "a".repeat(64)
    ];
    for (const value of values) {
      expect(hasher.digest(value, Buffer.byteLength(value))).toBe(
        createHash("sha256").update(value, "utf8").digest("hex")
      );
    }
  });

  it("rejects inconsistent UTF-8 byte accounting", () => {
    expect(paths.PathHasher).toBeTypeOf("function");
    const hasher = new paths.PathHasher();
    expect(() => hasher.digest("é", 1)).toThrow(
      "Hash text byte length mismatch"
    );
    expect(() => hasher.digest("a", 2)).toThrow(
      "Hash text byte length mismatch"
    );
  });
});
