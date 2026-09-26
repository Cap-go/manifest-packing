import { Buffer } from "node:buffer";
import { invalid, ManifestPackingError, resource } from "./errors.js";
import { DEFAULT_MANIFEST_LIMITS, type ManifestLimits } from "./types.js";

export const MAX_SIZE = (1n << 63n) - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function limitsFor(input?: Partial<ManifestLimits>): ManifestLimits {
  if (
    input !== undefined &&
    (!input || typeof input !== "object" || Array.isArray(input))
  ) {
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Resource limits must be an object"
    );
  }
  const limits = { ...DEFAULT_MANIFEST_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ManifestPackingError(
        "INVALID_INPUT",
        `Invalid resource limit: ${key}`
      );
    }
  }
  if (
    limits.maxEntries > 1_000_000 ||
    limits.maxPacketBytes > 64 * 1024 * 1024 ||
    limits.maxBlockBytes > 64 * 1024 * 1024 ||
    limits.maxStringBytes > 1024 * 1024 ||
    limits.maxDecodedBytes > 64 * 1024 * 1024 ||
    limits.maxMemoryBytes > 96 * 1024 * 1024
  ) {
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Resource limits exceed supported ceilings"
    );
  }
  return limits;
}

export function sizeValue(value: number | bigint | null): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n && value <= MAX_SIZE) return value;
  } else if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return BigInt(value);
  }
  throw new ManifestPackingError(
    "INVALID_INPUT",
    "File sizes must be nonnegative safe integers or signed-64-bit bigints"
  );
}

export function publicSize(value: bigint): number | bigint {
  return value <= MAX_SAFE ? Number(value) : value;
}

export function utf8(value: string, max: number): Buffer {
  if (typeof value !== "string")
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Manifest strings must be strings"
    );
  // Reject lone surrogates before UTF-8 encoding can silently replace them.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ManifestPackingError(
          "INVALID_INPUT",
          "Malformed UTF-16 input"
        );
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new ManifestPackingError("INVALID_INPUT", "Malformed UTF-16 input");
    }
  }
  const length = Buffer.byteLength(value);
  if (length > max) resource("String exceeds byte limit");
  return Buffer.from(value, "utf8");
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    return invalid("Malformed UTF-8");
  }
}

export function validatePath(value: string, source = false): void {
  if (
    !value ||
    value.charCodeAt(0) === 47 ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
  ) {
    throw new ManifestPackingError(
      source ? "INVALID_INPUT" : "INVALID_PACKET",
      "Invalid relative manifest path"
    );
  }
}

export function varLength(value: number): number {
  let length = 1;
  while (value >= 128) {
    value = Math.floor(value / 128);
    length++;
  }
  return length;
}

export class Writer {
  private bytes: Buffer;
  length = 0;

  constructor(
    readonly limit: number,
    initial = 256
  ) {
    this.bytes = Buffer.allocUnsafe(Math.min(limit, initial));
  }

  private reserve(count: number): void {
    const needed = this.length + count;
    if (needed > this.limit) resource("Encoded block exceeds byte limit");
    if (needed > this.bytes.length) {
      const next = Buffer.allocUnsafe(
        Math.min(this.limit, Math.max(needed, this.bytes.length * 2))
      );
      next.set(this.bytes.subarray(0, this.length));
      this.bytes = next;
    }
  }

  byte(value: number): void {
    this.reserve(1);
    this.bytes[this.length++] = value;
  }

  uint(value: number): void {
    while (value >= 128) {
      this.byte((value % 128) | 128);
      value = Math.floor(value / 128);
    }
    this.byte(value);
  }

  size(value: bigint): void {
    if (value <= MAX_SAFE) {
      this.uint(Number(value));
      return;
    }
    while (value >= 128n) {
      this.byte(Number(value & 127n) | 128);
      value >>= 7n;
    }
    this.byte(Number(value));
  }

  data(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.bytes.set(bytes, this.length);
    this.length += bytes.length;
  }

  lp(bytes: Uint8Array): void {
    this.uint(bytes.length);
    this.data(bytes);
  }

  finish(): Buffer {
    return this.bytes.subarray(0, this.length);
  }
}

export class Reader {
  offset = 0;
  private readonly buffer: Buffer;

  constructor(readonly bytes: Uint8Array) {
    // One shared view per block, rather than two temporary views per hash.
    this.buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  byte(): number {
    if (this.offset >= this.bytes.length) invalid("Truncated packet");
    return this.bytes[this.offset++]!;
  }

  uint(max: number): number {
    let value = 0;
    let factor = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.byte();
      value += (b & 127) * factor;
      if (!Number.isSafeInteger(value) || value > max)
        resource("Integer exceeds field limit");
      if (b < 128) {
        if (i > 0 && b === 0) invalid("Nonminimal VarUInt");
        return value;
      }
      factor *= 128;
    }
    return invalid("VarUInt overflow");
  }

  size(): number | bigint {
    // All ordinary sizes avoid per-byte bigint arithmetic.
    let value = 0;
    let factor = 1;
    for (let i = 0; i < 7; i++) {
      const b = this.byte();
      value += (b & 127) * factor;
      if (b < 128) {
        if (i > 0 && b === 0) invalid("Nonminimal VarUInt");
        return value;
      }
      factor *= 128;
    }
    let wide = BigInt(value);
    for (let i = 7; i < 9; i++) {
      const b = this.byte();
      wide |= BigInt(b & 127) << BigInt(i * 7);
      if (b < 128) {
        if (b === 0) invalid("Nonminimal VarUInt");
        if (wide > MAX_SIZE) invalid("File size exceeds signed bigint");
        return publicSize(wide);
      }
    }
    return invalid("File-size VarUInt overflow");
  }

  data(length: number): Uint8Array {
    if (length > this.bytes.length - this.offset) invalid("Truncated field");
    const bytes = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  encoded(length: number, encoding: "hex" | "base64"): string {
    if (length > this.bytes.length - this.offset) invalid("Truncated field");
    const start = this.offset;
    this.offset += length;
    return this.buffer.toString(encoding, start, this.offset);
  }

  lp(max: number): Uint8Array {
    return this.data(this.uint(max));
  }

  end(): void {
    if (this.offset !== this.bytes.length) invalid("Unexpected trailing bytes");
  }
}

/** Explicit budgets cover expansion before retaining strings or allocating arrays. */
export class Budget {
  decodedBytes = 0;

  constructor(
    readonly limits: ManifestLimits,
    readonly fixedBytes: number
  ) {
    this.check();
  }

  text(bytes: number): void {
    this.decodedBytes += bytes;
    if (this.decodedBytes > this.limits.maxDecodedBytes)
      resource("Decoded text exceeds byte limit");
    this.check();
  }

  private check(): void {
    // Two-byte JS strings, plus headroom for native codec state and temporary copies.
    if (this.fixedBytes + this.decodedBytes * 2 > this.limits.maxMemoryBytes) {
      resource("Manifest exceeds working-memory budget");
    }
  }
}
