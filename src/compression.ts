import { Buffer } from "node:buffer";
import * as zlib from "node:zlib";
import { Reader, varLength, Writer } from "./binary.js";
import { invalid, ManifestPackingError, resource } from "./errors.js";
import type { Compression } from "./types.js";

export interface Block {
  readonly codec: number;
  readonly rawLength: number;
  readonly data: Uint8Array;
}

export const NATIVE_WORKSPACE_BYTES = 16 * 1024 * 1024;

export function blockLength(block: Block): number {
  return (
    1 +
    varLength(block.rawLength) +
    varLength(block.data.length) +
    block.data.length
  );
}

export function readBlock(reader: Reader, max: number): Block {
  const codec = reader.byte();
  if (codec > 2) invalid("Unknown compression codec");
  const rawLength = reader.uint(max);
  const storedLength = reader.uint(max);
  if (codec === 0 && rawLength !== storedLength)
    invalid("Raw block lengths differ");
  return { codec, rawLength, data: reader.data(storedLength) };
}

export function writeBlock(writer: Writer, block: Block): void {
  writer.byte(block.codec);
  writer.uint(block.rawLength);
  writer.uint(block.data.length);
  writer.data(block.data);
}

/** Checks one dictionary-free Zstd frame and caps its native window before decoding. */
export function validateZstdFrame(data: Uint8Array, rawLength: number): void {
  const reader = new Reader(data);
  if (
    reader.byte() !== 0x28 ||
    reader.byte() !== 0xb5 ||
    reader.byte() !== 0x2f ||
    reader.byte() !== 0xfd
  ) {
    invalid("Invalid Zstandard frame magic");
  }
  const flags = reader.byte();
  // RFC 8878: bit 3 is reserved; bit 4 is unused and decoders must ignore it.
  if (flags & 0x08) invalid("Unsupported Zstandard header bits");
  const single = (flags & 0x20) !== 0;
  if (!single) {
    const descriptor = reader.byte();
    const base = 2 ** (10 + (descriptor >> 3));
    const window = base + (base / 8) * (descriptor & 7);
    if (window > NATIVE_WORKSPACE_BYTES)
      resource("Zstandard window exceeds memory budget");
  }
  const dictionaryBytes = [0, 1, 2, 4][flags & 3]!;
  for (let i = 0; i < dictionaryBytes; i++) {
    if (reader.byte() !== 0)
      invalid("External compression dictionaries are unsupported");
  }
  const sizeFlag = flags >> 6;
  const sizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag;
  if (sizeBytes) {
    let size = 0n;
    for (let i = 0; i < sizeBytes; i++)
      size |= BigInt(reader.byte()) << BigInt(i * 8);
    if (sizeFlag === 1) size += 256n;
    if (size !== BigInt(rawLength)) invalid("Zstandard content size mismatch");
    if (single && size > BigInt(NATIVE_WORKSPACE_BYTES))
      resource("Zstandard window exceeds memory budget");
  }
  let last = false;
  while (!last) {
    const bits = reader.byte() | (reader.byte() << 8) | (reader.byte() << 16);
    last = (bits & 1) !== 0;
    const kind = (bits >> 1) & 3;
    const length = bits >>> 3;
    if (kind === 3 || length > 131072)
      invalid("Invalid Zstandard block header");
    reader.data(kind === 1 ? 1 : length);
  }
  if (flags & 4) reader.data(4);
  reader.end();
}

interface NativeInfo {
  buffer: Uint8Array;
  engine: { bytesWritten: number };
}

function nativeInfo(value: unknown): value is NativeInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "buffer" in value &&
    value.buffer instanceof Uint8Array &&
    "engine" in value &&
    typeof value.engine === "object" &&
    value.engine !== null &&
    "bytesWritten" in value.engine &&
    Number.isSafeInteger(value.engine.bytesWritten)
  );
}

export function decompress(block: Block): Uint8Array {
  if (block.codec === 0) return block.data;
  if (block.codec === 2) validateZstdFrame(block.data, block.rawLength);
  try {
    const options = {
      info: true,
      maxOutputLength: Math.max(1, block.rawLength)
    };
    const result: unknown =
      block.codec === 1
        ? zlib.brotliDecompressSync(block.data, options)
        : zlib.zstdDecompressSync(block.data, {
            ...options,
            params: { [zlib.constants.ZSTD_d_windowLogMax]: 24 }
          });
    if (!nativeInfo(result)) {
      throw new ManifestPackingError(
        "UNSUPPORTED_RUNTIME",
        "Runtime must report native decompressor input consumption"
      );
    }
    if (
      result.buffer.length !== block.rawLength ||
      result.engine.bytesWritten !== block.data.length
    ) {
      invalid("Compressed block length or input consumption mismatch");
    }
    return result.buffer;
  } catch (error) {
    if (error instanceof ManifestPackingError) throw error;
    throw new ManifestPackingError(
      "COMPRESSION_ERROR",
      "Invalid or oversized compressed block"
    );
  }
}

export function compressBlock(
  raw: Uint8Array,
  selection: Compression,
  names: boolean
): Block {
  if (!["auto", "none", "brotli", "zstd"].includes(selection)) {
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Unknown compression selection"
    );
  }
  let best: Block = { codec: 0, rawLength: raw.length, data: raw };
  if (selection === "none" || raw.length === 0) return best;
  const codecs =
    selection === "auto"
      ? names
        ? [1]
        : [1, 2]
      : [selection === "brotli" ? 1 : 2];
  for (const codec of codecs) {
    let data: Buffer;
    try {
      data =
        codec === 1
          ? zlib.brotliCompressSync(raw, {
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: names ? 11 : 6,
                [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
              }
            })
          : zlib.zstdCompressSync(raw, {
              params: {
                [zlib.constants.ZSTD_c_compressionLevel]: 3,
                [zlib.constants.ZSTD_c_windowLog]: 22
              }
            });
    } catch {
      // A codec is only a candidate in automatic mode. Some workerd releases
      // fail native Zstd compression on incompressible input (workerd#6769).
      // The already-valid raw/Brotli candidate preserves a usable packet.
      if (selection === "auto") continue;
      throw new ManifestPackingError(
        "COMPRESSION_ERROR",
        "Native compression failed; Node with Zstandard or Workers nodejs_compat is required"
      );
    }
    const candidate: Block = { codec, rawLength: raw.length, data };
    if (selection !== "auto" || blockLength(candidate) < blockLength(best))
      best = candidate;
  }
  return best;
}
