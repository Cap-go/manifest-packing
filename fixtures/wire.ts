import { createHash } from "node:crypto";

import type { UnpackManifestInput } from "../src/index.js";

export function bytes(
  ...parts: (Uint8Array | readonly number[])[]
): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

export function uint(value: number | bigint): Uint8Array {
  let remaining = BigInt(value);
  const result: number[] = [];
  do {
    const next = Number(remaining & 127n);
    remaining >>= 7n;
    result.push(next | (remaining ? 128 : 0));
  } while (remaining);
  return Uint8Array.from(result);
}

export function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function lp(value: string | Uint8Array): Uint8Array {
  const encoded = typeof value === "string" ? text(value) : value;
  return bytes(uint(encoded.length), encoded);
}

export function block(data: Uint8Array, codec = 0, rawLength = data.length) {
  return bytes([codec], uint(rawLength), uint(data.length), data);
}

/** Independent framing deliberately does not import the implementation's writer. */
export function packet({
  count = 1,
  flags = 0,
  headers = new Uint8Array(),
  names = block(lp("a")),
  tails = block(literalTail()),
  version = 1,
  sizes,
  suffix = new Uint8Array()
}: {
  count?: number;
  flags?: number;
  headers?: Uint8Array;
  names?: Uint8Array;
  tails?: Uint8Array;
  version?: number;
  sizes?: readonly (number | bigint)[];
  suffix?: Uint8Array;
} = {}): UnpackManifestInput {
  const main = withDigest(
    bytes(
      [version >> 8, version & 255],
      uint(count),
      [flags],
      headers,
      names,
      tails,
      suffix
    ),
    count
  );
  if (count > 10_000) return main;
  const values = sizes ?? Array.from({ length: count }, () => 1);
  return withSizePacket(
    main,
    bytes(...values.map((size) => bytes([0x5a], uint(size))))
  );
}

export function withSizePacket(
  main: UnpackManifestInput,
  entries: Uint8Array
): UnpackManifestInput {
  const manifest_size = bytes(
    [0, 1],
    main.payload_hash,
    uint(main.entry_count),
    entries
  );
  return {
    ...main,
    manifest_size,
    manifest_size_payload_hash: createHash("sha256")
      .update(manifest_size)
      .digest()
  };
}

export function withDigest(
  manifest: Uint8Array,
  entryCount = 1
): UnpackManifestInput {
  return {
    format_version: 1,
    entry_count: entryCount,
    payload_hash: createHash("sha256").update(manifest).digest(),
    manifest
  };
}

export function literalTail(
  _size: number | bigint = 1,
  hash = "x",
  path = "p"
) {
  return bytes(lp(path), [0x5a, 3], lp(hash));
}

export function readUint(
  data: Uint8Array,
  cursor: { position: number }
): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const part = data[cursor.position++]!;
    value += (part & 127) * 2 ** shift;
    if (!(part & 128)) return value;
    shift += 7;
  }
}

/** Independent structural inspection for encoder selector tests. */
export function inspectPacket(data: Uint8Array) {
  const cursor = { position: 2 };
  const count = readUint(data, cursor);
  const flags = data[cursor.position++]!;
  const headers: string[] = [];
  for (let bit = 0; bit < 4; bit++) {
    if (flags & (1 << bit)) {
      const length = readUint(data, cursor);
      headers.push(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          data.subarray(cursor.position, cursor.position + length)
        )
      );
      cursor.position += length;
    }
  }
  const blocks = Array.from({ length: 2 }, () => {
    const codec = data[cursor.position++]!;
    const rawLength = readUint(data, cursor);
    const storedLength = readUint(data, cursor);
    const stored = data.subarray(
      cursor.position,
      cursor.position + storedLength
    );
    cursor.position += storedLength;
    return { codec, rawLength, storedLength, stored };
  });
  return { count, flags, headers, blocks, end: cursor.position };
}
