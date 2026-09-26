import { brotliCompressSync, zstdCompressSync } from "node:zlib";

import type {
  ManifestPackingErrorCode,
  UnpackManifestInput,
  UnpackManifestOptions
} from "../src/index.js";
import {
  block,
  bytes,
  literalTail,
  lp,
  packet,
  text,
  uint,
  withDigest
} from "./wire.js";

export interface AdversarialPacket {
  readonly name: string;
  readonly input: UnpackManifestInput;
  readonly options?: UnpackManifestOptions;
  readonly expectedCodes: readonly ManifestPackingErrorCode[];
}

/** Small, independently framed inputs reusable in Node and Workers safety probes. */
export function adversarialPackets(): AdversarialPacket[] {
  const invalid = ["INVALID_PACKET"] as const;
  const resource = ["RESOURCE_LIMIT"] as const;
  const compressed = [
    "COMPRESSION_ERROR",
    "INVALID_PACKET",
    "RESOURCE_LIMIT"
  ] as const;
  const cases: AdversarialPacket[] = [];
  const add = (
    name: string,
    input: UnpackManifestInput,
    expectedCodes: readonly ManifestPackingErrorCode[] = invalid,
    options?: UnpackManifestOptions
  ) => {
    cases.push({ name, input, expectedCodes, ...(options ? { options } : {}) });
  };
  const valid = packet();
  add("external format version", { ...valid, format_version: 1 }, [
    "UNSUPPORTED_VERSION"
  ]);
  add("embedded format version", packet({ version: 1 }), [
    "UNSUPPORTED_VERSION"
  ]);
  add("packet trailer", packet({ suffix: Uint8Array.of(0) }));
  add("entry count metadata mismatch", { ...valid, entry_count: 2 }, [
    "METADATA_MISMATCH"
  ]);
  add("file size metadata mismatch", { ...valid, total_file_size: 2 }, [
    "METADATA_MISMATCH"
  ]);
  add("bad payload digest", { ...valid, payload_hash: new Uint8Array(32) }, [
    "INTEGRITY_MISMATCH"
  ]);
  add(
    "nonminimal count",
    withDigest(bytes([0, 0, 0x81, 0], valid.manifest.subarray(3)))
  );
  add(
    "unterminated count",
    withDigest(bytes([0, 0], new Uint8Array(10).fill(0x80)))
  );
  add("overflowing count", withDigest(bytes([0, 0], uint(1n << 64n), [0])), [
    "RESOURCE_LIMIT",
    "TOO_MANY_ENTRIES",
    "INVALID_PACKET"
  ]);
  add("huge count declaration", packet({ count: 1_000_001 }), [
    "RESOURCE_LIMIT",
    "TOO_MANY_ENTRIES"
  ]);
  add("raw block size mismatch", packet({ names: block(lp("a"), 0, 3) }));
  add(
    "huge raw block declaration",
    packet({ names: block(lp("a"), 0, 1 << 30) }),
    resource
  );
  add(
    "stored length beyond packet",
    packet({ names: bytes([0], uint(2), uint(1 << 20), lp("a")) })
  );
  add(
    "nonminimal block length",
    packet({ names: bytes([0, 0x82, 0, 2], lp("a")) })
  );
  add("missing filename", packet({ names: block(new Uint8Array()) }));
  add("extra filename", packet({ names: block(bytes(lp("a"), lp("b"))) }));
  add("extra tail byte", packet({ tails: block(bytes(literalTail(), [0])) }));
  add("missing tail", packet({ tails: block(new Uint8Array()) }));
  add(
    "nonminimal filename length",
    packet({ names: block(bytes([0x81, 0], text("a"))) })
  );
  add(
    "filename length beyond data",
    packet({ names: block(bytes(uint(100), text("a"))) })
  );
  add(
    "huge filename declaration",
    packet({ names: block(bytes(uint(1 << 24), text("a"))) }),
    ["RESOURCE_LIMIT", "INVALID_PACKET"]
  );
  add(
    "initial prefix exceeds predecessor",
    packet({ flags: 0x40, names: block(bytes(uint(1), text("a"), [0])) })
  );
  add(
    "missing prefix suffix terminator",
    packet({ flags: 0x40, names: block(bytes(uint(0), text("a"))) })
  );
  add(
    "nonmaximal prefix",
    packet({
      count: 2,
      flags: 0x40,
      names: block(bytes(uint(0), text("ab"), [0], uint(0), text("ac"), [0])),
      tails: block(bytes(literalTail(), literalTail()))
    })
  );
  add(
    "later prefix exceeds predecessor",
    packet({
      count: 2,
      flags: 0x40,
      names: block(bytes(uint(0), text("a"), [0], uint(2), [0])),
      tails: block(bytes(literalTail(), literalTail()))
    })
  );
  add(
    "overflowing file size",
    packet({ tails: block(literalTail(1n << 63n)) })
  );
  add(
    "nonminimal file size",
    packet({ tails: block(bytes(lp("p"), [0x81, 0, 3], lp("x"))) })
  );
  for (const width of [7, 8, 9, 10]) {
    add(
      `nonminimal ${width}-byte file size`,
      packet({
        tails: block(
          bytes(
            lp("p"),
            [0x81],
            new Uint8Array(width - 2).fill(0x80),
            [0, 3],
            lp("x")
          )
        )
      })
    );
  }
  add(
    "unterminated file size",
    packet({ tails: block(bytes(lp("p"), new Uint8Array(10).fill(0x80))) })
  );
  add(
    "overflowing absolute size total",
    packet({
      count: 2,
      names: block(bytes(lp("a"), lp("b"))),
      tails: block(bytes(literalTail((1n << 63n) - 1n), literalTail(1)))
    })
  );
  add(
    "overflowing delta size",
    packet({
      count: 2,
      flags: 0x80,
      names: block(bytes(lp("a"), lp("b"))),
      tails: block(bytes(literalTail((1n << 63n) - 1n), literalTail(1)))
    })
  );
  for (const kind of [4, 255])
    add(
      `unknown hash kind ${kind}`,
      packet({ tails: block(bytes(lp("p"), uint(1), [kind])) })
    );
  for (const [kind, width] of [
    [0, 32],
    [1, 256],
    [2, 256]
  ])
    add(
      `truncated hash kind ${kind}`,
      packet({
        tails: block(
          bytes(lp("p"), uint(1), [kind!], new Uint8Array(width! - 1))
        )
      })
    );
  for (const mode of [3, 4, 127, 255])
    add(
      `invalid mixed entry mode ${mode}`,
      packet({ flags: 0x30, tails: block(bytes([mode], literalTail())) })
    );
  for (const codec of [3, 4, 255])
    add(
      `unknown compression selector ${codec}`,
      packet({ names: block(lp("a"), codec) }),
      ["INVALID_PACKET", "COMPRESSION_ERROR"]
    );
  for (const bad of [
    Uint8Array.of(0xc0, 0xaf),
    Uint8Array.of(0xed, 0xa0, 0x80),
    Uint8Array.of(0xf4, 0x90, 0x80, 0x80),
    Uint8Array.of(0xff)
  ]) {
    const label = Buffer.from(bad).toString("hex");
    add(`invalid filename UTF-8 ${label}`, packet({ names: block(lp(bad)) }));
    add(
      `invalid literal path UTF-8 ${label}`,
      packet({ tails: block(bytes(lp(bad), uint(1), [3], lp("x"))) })
    );
    add(
      `invalid literal hash UTF-8 ${label}`,
      packet({ tails: block(bytes(lp("p"), uint(1), [3], lp(bad))) })
    );
    add(
      `invalid header UTF-8 ${label}`,
      packet({ flags: 1, headers: lp(bad) })
    );
  }
  for (const path of [
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
  ]) {
    add(
      `unsafe filename ${JSON.stringify(path)}`,
      packet({ names: block(lp(path)) })
    );
    add(
      `unsafe literal path ${JSON.stringify(path)}`,
      packet({ tails: block(literalTail(1, "x", path)) })
    );
  }
  add(
    "legacy missing org",
    packet({
      flags: 0x16,
      headers: bytes(lp("a"), lp("v")),
      tails: block(bytes(uint(1), [3], lp("x")))
    })
  );
  add(
    "legacy missing app",
    packet({
      flags: 0x15,
      headers: bytes(lp("o"), lp("v")),
      tails: block(bytes(uint(1), [3], lp("x")))
    })
  );
  add(
    "legacy missing version",
    packet({
      flags: 0x13,
      headers: bytes(lp("o"), lp("a")),
      tails: block(bytes(uint(1), [3], lp("x")))
    })
  );
  add(
    "legacy empty org",
    packet({
      flags: 0x17,
      headers: bytes(lp(""), lp("a"), lp("v")),
      tails: block(bytes(uint(1), [3], lp("x")))
    })
  );
  add(
    "delta missing headers",
    packet({ flags: 0x20, tails: block(bytes(uint(1), [3], lp("x"))) })
  );
  add(
    "mixed legacy missing headers",
    packet({ flags: 0x30, tails: block(bytes([1], uint(1), [3], lp("x"))) })
  );
  add(
    "mixed delta missing headers",
    packet({ flags: 0x30, tails: block(bytes([2], uint(1), [3], lp("x"))) })
  );
  add(
    "unsafe reconstructed path",
    packet({
      flags: 0x17,
      headers: bytes(lp("o"), lp("a"), lp("../v")),
      tails: block(bytes(uint(1), [3], lp("x")))
    })
  );
  add("decoded bytes budget", valid, resource, {
    limits: { maxDecodedBytes: 1 }
  });
  add("packet bytes budget", valid, resource, {
    limits: { maxPacketBytes: 1 }
  });
  add("block bytes budget", valid, resource, { limits: { maxBlockBytes: 1 } });
  add("memory budget", valid, resource, { limits: { maxMemoryBytes: 1 } });
  add(
    "prefix reconstruction exceeds string budget",
    packet({
      count: 2,
      flags: 0x40,
      names: block(bytes([0], text("ab"), [0, 2], text("c"), [0])),
      tails: block(bytes(literalTail(), literalTail()))
    }),
    resource,
    { limits: { maxStringBytes: 2 } }
  );
  add(
    "prefix reconstruction is invalid UTF-8",
    packet({
      count: 2,
      flags: 0x40,
      names: block(bytes([0, 0xc3, 0xa9, 0, 1, 0x61, 0])),
      tails: block(bytes(literalTail(), literalTail()))
    })
  );
  for (const mode of [1, 2]) {
    add(
      `reconstructed mode ${mode} path exceeds string budget`,
      packet({
        flags: (mode << 4) | 7,
        headers: bytes(lp("o"), lp("a"), lp("v")),
        tails: block(bytes(uint(1), [3], lp("x")))
      }),
      resource,
      { limits: { maxStringBytes: 10 } }
    );
  }
  add(
    "individual string budget",
    packet({ names: block(lp("long")) }),
    resource,
    { limits: { maxStringBytes: 1 } }
  );
  for (const [codec, compress] of [
    [1, brotliCompressSync],
    [2, zstdCompressSync]
  ] as const) {
    const encoded = compress(lp("a"));
    add(
      `codec ${codec} trailing junk`,
      packet({ names: block(bytes(encoded, [255]), codec, 2) }),
      compressed
    );
    add(
      `codec ${codec} second empty frame`,
      packet({
        names: block(bytes(encoded, compress(new Uint8Array())), codec, 2)
      }),
      compressed
    );
    add(
      `codec ${codec} second data frame`,
      packet({ names: block(bytes(encoded, encoded), codec, 4) }),
      compressed
    );
    add(
      `codec ${codec} truncated frame`,
      packet({ names: block(encoded.subarray(0, -1), codec, 2) }),
      compressed
    );
    add(
      `codec ${codec} wrong decoded length`,
      packet({ names: block(encoded, codec, 3) }),
      compressed
    );
    add(
      `codec ${codec} output exceeds declared limit`,
      packet({ names: block(compress(new Uint8Array(256 * 1024)), codec, 2) }),
      compressed
    );
    add(
      `codec ${codec} huge output declaration`,
      packet({ names: block(encoded, codec, 1 << 30) }),
      resource
    );
  }
  // Hand-built Zstandard frames exercise RFC 8878 framing without the encoder.
  const magic = [0x28, 0xb5, 0x2f, 0xfd];
  for (const [name, frame] of [
    ["wrong magic", bytes([0, 0, 0, 0, 0x20, 2, 17, 0, 0, 1, 97])],
    ["reserved header bit", bytes(magic, [0x28, 2, 17, 0, 0, 1, 97])],
    ["nonzero dictionary id", bytes(magic, [0x21, 1, 2, 17, 0, 0, 1, 97])],
    ["reserved block type", bytes(magic, [0x20, 2, 23, 0, 0, 1, 97])],
    ["block above 128 KiB", bytes(magic, [0x20, 2, 9, 0, 16])],
    ["missing raw block data", bytes(magic, [0x20, 2, 17, 0, 0, 1])],
    ["missing checksum", bytes(magic, [0x24, 2, 17, 0, 0, 1, 97])],
    ["wrong checksum", bytes(magic, [0x24, 2, 17, 0, 0, 1, 97, 0, 0, 0, 0])],
    ["wrong frame content size", bytes(magic, [0x20, 3, 17, 0, 0, 1, 97])],
    ["missing final block", bytes(magic, [0x20, 2, 16, 0, 0, 1, 97])],
    ["skippable frame", bytes([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0])]
  ] as const) {
    add(`Zstandard ${name}`, packet({ names: block(frame, 2, 2) }), compressed);
  }
  add(
    "Zstandard window exceeds memory ceiling",
    packet({ names: block(bytes(magic, [0, 120, 17, 0, 0, 1, 97]), 2, 2) }),
    resource
  );
  add(
    "Zstandard single segment exceeds memory ceiling",
    packet({
      names: block(bytes(magic, [0xa0, 1, 0, 0, 1]), 2, 16 * 1024 * 1024 + 1)
    }),
    resource,
    { limits: { maxBlockBytes: 32 * 1024 * 1024 } }
  );
  return cases;
}
