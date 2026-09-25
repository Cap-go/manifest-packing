import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MANIFEST_FORMAT_VERSION,
  MAX_MANIFEST_ENTRIES,
  ManifestPackingError,
  packManifest,
  unpackManifest,
  type ManifestEntry
} from "../src/index.js";
import {
  expectedEntries,
  syntheticBytes,
  syntheticContext,
  syntheticDeltaPath,
  syntheticManifest
} from "../fixtures/synthetic.js";
import {
  block,
  bytes,
  inspectPacket,
  literalTail,
  lp,
  packet,
  text,
  uint,
  withDigest
} from "../fixtures/wire.js";

const raw = { compression: { filenames: "none", metadata: "none" } } as const;
const entry: ManifestEntry = {
  id: 1,
  app_version_id: 2,
  file_name: "a",
  s3_path: "p",
  file_hash: "x",
  file_size: 1
};

describe("manifest format v0", () => {
  it("exports version zero and preserves the exact uncompressed golden packet", () => {
    expect(MANIFEST_FORMAT_VERSION).toBe(0);
    const packed = packManifest([entry], { ...raw, filenameTransform: "raw" });
    expect(Buffer.from(packed.manifest).toString("hex")).toBe(
      "000001000002020161000606017001030178"
    );
    expect(packed).toMatchObject({
      format_version: 0,
      entry_count: 1,
      total_file_size: 1
    });
    expect(packed.payload_hash).toEqual(
      createHash("sha256").update(packed.manifest).digest()
    );
    expect(
      unpackManifest(
        withDigest(Buffer.from("000001000002020161000606017001030178", "hex"))
      )
    ).toEqual(expectedEntries([entry]));
  });

  it("round-trips an empty manifest", () => {
    const packed = packManifest([], raw);
    expect(packed.entry_count).toBe(0);
    expect(packed.total_file_size).toBe(0);
    expect((inspectPacket(packed.manifest).flags >> 4) & 3).toBe(3);
    expect(unpackManifest(packed)).toEqual([]);
  });

  it.each([1, 10, 257, 5000, 10000])(
    "round-trips %i synthetic entries",
    (count) => {
      const entries = syntheticManifest(count);
      const packed = packManifest(entries);
      expect(unpackManifest(packed)).toEqual(expectedEntries(entries));
      expect(packed.total_file_size).toBe(
        entries.reduce((sum, row) => sum + Number(row.file_size), 0)
      );
    }
  );

  it("keeps the default 10,000 limit and accepts a deliberate higher limit", () => {
    expect(MAX_MANIFEST_ENTRIES).toBe(10_000);
    const entries = Array.from({ length: 10_001 }, () => entry);
    expect(() => packManifest(entries)).toThrow(ManifestPackingError);
    const packed = packManifest(entries, { limits: { maxEntries: 10_001 } });
    expect(() => unpackManifest(packed)).toThrow(ManifestPackingError);
    expect(
      unpackManifest(packed, { limits: { maxEntries: 10_001 } })
    ).toHaveLength(10_001);
  });

  it("preserves duplicate tuple multiplicity and stable equal-name ordering", () => {
    const entries = [
      { ...entry, file_name: "z", file_size: 4 },
      { ...entry, file_name: "a", file_hash: "first" },
      { ...entry, file_name: "a", file_hash: "second" },
      { ...entry, file_name: "a", file_hash: "first" }
    ];
    expect(unpackManifest(packManifest(entries))).toEqual(
      expectedEntries(entries)
    );
  });

  it.each(["raw", "prefix", "auto"] as const)(
    "preserves UTF-8 bytes with %s filenames",
    (filenameTransform) => {
      const names = [
        "🧪.js",
        "\ue000.js",
        "é.js",
        "ê.js",
        "e\u0301.js",
        "\ufeffindex.html",
        "Ω/日本語/你好 world%?#.js"
      ];
      const entries = names.map((name) => ({
        ...entry,
        file_name: name,
        s3_path: `synthetic/${name}`,
        file_hash: `\ufeff${name}`
      }));
      const result = unpackManifest(
        packManifest(entries, { ...raw, filenameTransform })
      );
      expect(result).toEqual(expectedEntries(entries));
      expect(
        result.map((row) => row.file_name).indexOf("\ue000.js")
      ).toBeLessThan(result.map((row) => row.file_name).indexOf("🧪.js"));
    }
  );

  it("decodes a maximal prefix ending inside a multibyte character", () => {
    const names = bytes(uint(0), text("é"), [0], uint(1), [0xaa, 0]);
    expect(
      unpackManifest(
        packet({
          count: 2,
          flags: 0x40,
          names: block(names),
          tails: block(bytes(literalTail(), literalTail()))
        })
      ).map((row) => row.file_name)
    ).toEqual(["é", "ê"]);
  });

  it("grows filename storage while preserving multibyte prefixes and duplicates", () => {
    const shared = "assets/" + "é".repeat(150);
    const first = shared + "a";
    const second = shared + "b".repeat(400);
    const prefixLength = Buffer.byteLength(shared);
    const names = bytes(
      uint(0),
      text(first),
      [0],
      uint(prefixLength),
      text("b".repeat(400)),
      [0],
      uint(Buffer.byteLength(second)),
      [0],
      uint(prefixLength),
      [0]
    );
    const input = packet({
      count: 4,
      flags: 0x40,
      names: block(names),
      tails: block(
        bytes(literalTail(1), literalTail(2), literalTail(3), literalTail(4))
      )
    });
    expect(
      unpackManifest(input).map((row) => [row.file_name, row.file_size])
    ).toEqual([
      [first, 1],
      [second, 2],
      [second, 3],
      [shared, 4]
    ]);
  });

  it("counts decoded UTF-8 bytes at the exact aggregate budget boundary", () => {
    const source = { ...entry, file_name: "é", s3_path: "p", file_hash: "x" };
    const packed = packManifest([source], {
      ...raw,
      limits: { maxDecodedBytes: 4 }
    });
    expect(unpackManifest(packed, { limits: { maxDecodedBytes: 4 } })).toEqual(
      expectedEntries([source])
    );
    expect(() =>
      unpackManifest(packed, { limits: { maxDecodedBytes: 3 } })
    ).toThrow(ManifestPackingError);
  });

  it("preserves encoded order when independently decoding unsorted names", () => {
    const input = packet({
      count: 2,
      names: block(bytes(lp("z"), lp("a"))),
      tails: block(bytes(literalTail(1), literalTail(2)))
    });
    expect(
      unpackManifest(input).map((row) => [row.file_name, row.file_size])
    ).toEqual([
      ["z", 1],
      ["a", 2]
    ]);
  });

  it("does not mutate source rows, source order, or packet buffers", () => {
    const entries = Object.freeze(
      syntheticManifest(10)
        .reverse()
        .map((row) => Object.freeze(row))
    );
    const before = entries.map((row) => ({ ...row }));
    const packed = packManifest(entries);
    const manifestCopy = packed.manifest.slice();
    const hashCopy = packed.payload_hash.slice();
    const first = unpackManifest(packed);
    first[0]!.file_name = "mutated-return-value";
    expect(unpackManifest(packed)).toEqual(expectedEntries(entries));
    expect(entries).toEqual(before);
    expect(packed.manifest).toEqual(manifestCopy);
    expect(packed.payload_hash).toEqual(hashCopy);
  });

  it("respects Uint8Array byteOffset and byteLength for both buffers", () => {
    const packed = packManifest([entry]);
    const container = bytes([255, 255, 255], packed.manifest, [255, 255]);
    const hashContainer = bytes([1, 2], packed.payload_hash, [3]);
    expect(
      unpackManifest({
        ...packed,
        manifest: container.subarray(3, -2),
        payload_hash: hashContainer.subarray(2, -1)
      })
    ).toEqual(expectedEntries([entry]));
  });

  it("does not persist database identity fields", () => {
    const rows = unpackManifest(packManifest([entry]));
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "file_hash",
      "file_name",
      "file_size",
      "s3_path"
    ]);
    expect(
      packManifest([{ ...entry, id: 42, app_version_id: 99 }]).manifest
    ).toEqual(packManifest([entry]).manifest);
  });
});

describe("path representations", () => {
  it.each(["literal", "legacy", "delta", "mixed"] as const)(
    "selects and round-trips %s paths",
    (pathMode) => {
      const entries = syntheticManifest(12, { pathMode });
      const packed = packManifest(entries, {
        ...raw,
        context: syntheticContext
      });
      expect((inspectPacket(packed.manifest).flags >> 4) & 3).toBe(
        { literal: 0, legacy: 1, delta: 2, mixed: 3 }[pathMode]
      );
      expect(unpackManifest(packed)).toEqual(expectedEntries(entries));
    }
  );

  it.each(["legacy", "delta"] as const)(
    "infers exact %s context when omitted",
    (pathMode) => {
      const entries = syntheticManifest(5, { pathMode });
      const packed = packManifest(entries, raw);
      expect((inspectPacket(packed.manifest).flags >> 4) & 3).toBe(
        pathMode === "legacy" ? 1 : 2
      );
      expect(unpackManifest(packed)).toEqual(expectedEntries(entries));
    }
  );

  it("preserves session text, URL escaping, and exact hash text in delta paths", () => {
    const session = "\ufeff🔑 café";
    const entries = ["assets/a b%?#.js", "日本語/é+!~*'().js"].map((name) => ({
      ...entry,
      file_name: name,
      file_hash: "A".repeat(64),
      s3_path: syntheticDeltaPath(name, "A".repeat(64), session)
    }));
    const packed = packManifest(entries, {
      ...raw,
      context: { ...syntheticContext, session_key: session }
    });
    const inspected = inspectPacket(packed.manifest);
    expect(inspected.flags & 0x38).toBe(0x28);
    expect(inspected.headers).toContain(session);
    expect(unpackManifest(packed)).toEqual(expectedEntries(entries));
  });

  it("keeps plausible but non-exact delta paths literal", () => {
    const name = "a b.js";
    const correct = syntheticDeltaPath(name, entry.file_hash);
    const paths = [
      correct.replace("%20", "+"),
      correct.replace("delta/", "delta/incorrect-hash-"),
      "synthetic-demo/a b.js"
    ];
    for (const path of paths) {
      const source = { ...entry, file_name: name, s3_path: path };
      const packed = packManifest([source], {
        ...raw,
        context: syntheticContext
      });
      expect((inspectPacket(packed.manifest).flags >> 4) & 3).toBe(0);
      expect(unpackManifest(packed)).toEqual(expectedEntries([source]));
    }
  });

  it("preserves literal exceptions with conflicting inferred organization context", () => {
    const entries = [
      {
        ...entry,
        file_name: "a",
        s3_path: "orgs/synthetic-one/apps/example.synthetic.app/v/a"
      },
      {
        ...entry,
        file_name: "b",
        s3_path: "orgs/synthetic-two/apps/example.synthetic.app/v/b"
      }
    ];
    const packed = packManifest(entries, raw);
    expect((inspectPacket(packed.manifest).flags >> 4) & 3).toBe(3);
    expect(unpackManifest(packed)).toEqual(expectedEntries(entries));
  });

  it("preserves an unrecognized session directory with invalid UTF-8 bytes literally", () => {
    const source = {
      ...entry,
      s3_path:
        "orgs/synthetic-org/apps/example.synthetic.app/delta/ff/unknown_a"
    };
    const packed = packManifest([source], raw);
    expect((inspectPacket(packed.manifest).flags >> 4) & 3).toBe(0);
    expect(unpackManifest(packed)).toEqual(expectedEntries([source]));
  });

  it("gives an exact delta reconstruction priority over legacy recognition", () => {
    const fileHash = "x";
    const fileName = "a";
    const source = {
      ...entry,
      file_hash: fileHash,
      file_name: fileName,
      s3_path: syntheticDeltaPath(fileName, fileHash)
    };
    expect(
      (inspectPacket(
        packManifest([source], {
          ...raw,
          context: { ...syntheticContext, version_name: "delta" }
        }).manifest
      ).flags >>
        4) &
        3
    ).toBe(2);
  });
});

describe("hash and integer representations", () => {
  it.each([
    [0, 32, "hex"],
    [1, 256, "base64"],
    [2, 256, "hex"]
  ] as const)(
    "decodes independently framed hash kind %i",
    (kind, width, encoding) => {
      const hashBytes = Uint8Array.from({ length: width }, (_, index) => index);
      const input = packet({
        tails: block(bytes(lp("p"), uint(1), [kind], hashBytes))
      });
      expect(unpackManifest(input)[0]!.file_hash).toBe(
        Buffer.from(hashBytes).toString(encoding)
      );
      const source = {
        ...entry,
        file_hash: Buffer.from(hashBytes).toString(encoding)
      };
      const packed = packManifest([source], {
        ...raw,
        filenameTransform: "raw"
      });
      expect(inspectPacket(packed.manifest).blocks[1]!.stored).toEqual(
        bytes(lp("p"), uint(1), [kind], hashBytes)
      );
    }
  );

  it.each([
    ["00".repeat(32), 0],
    [Buffer.from(syntheticBytes(256)).toString("base64"), 1],
    ["ab".repeat(256), 2],
    ["AB".repeat(32), 3],
    ["AB".repeat(256), 3],
    ["legacy hash ☃", 3],
    ["", 3]
  ] as const)("preserves exact hash representation %#", (hash, kind) => {
    const source = { ...entry, file_hash: hash };
    const packed = packManifest([source], { ...raw, filenameTransform: "raw" });
    expect(inspectPacket(packed.manifest).blocks[1]!.stored[3]).toBe(kind);
    expect(unpackManifest(packed)).toEqual(expectedEntries([source]));
  });

  it("stores noncanonical Base64 literally, including nonzero unused padding bits", () => {
    const canonical = Buffer.alloc(256).toString("base64");
    const hashes = [
      canonical.replace(/AA==$/, "AB=="),
      canonical.slice(0, -2),
      `${canonical}\n`,
      canonical.replace("A", "-")
    ];
    for (const hash of hashes) {
      const source = { ...entry, file_hash: hash };
      const packed = packManifest([source], raw);
      expect(inspectPacket(packed.manifest).blocks[1]!.stored[3]).toBe(3);
      expect(unpackManifest(packed)[0]!.file_hash).toBe(hash);
    }
  });

  it.each([
    0,
    127,
    128,
    2 ** 49 - 1,
    2 ** 49,
    2 ** 49 + 1,
    Number.MAX_SAFE_INTEGER - 1,
    Number.MAX_SAFE_INTEGER,
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    (1n << 63n) - 1n
  ])("round-trips file size %s without precision loss", (size) => {
    const source = { ...entry, file_size: size };
    const packed = packManifest([source], raw);
    expect(unpackManifest(packed)).toEqual(expectedEntries([source]));
    expect(packed.total_file_size).toBe(
      typeof size === "bigint" && size <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(size)
        : size
    );
  });

  it.each([
    0n,
    127n,
    128n,
    (1n << 49n) - 1n,
    1n << 49n,
    (1n << 49n) + 1n,
    (1n << 53n) - 1n,
    1n << 53n,
    (1n << 53n) + 1n,
    (1n << 56n) - 1n,
    1n << 56n,
    (1n << 63n) - 1n
  ])("decodes independently framed integer boundary %s", (size) => {
    const input = packet({ tails: block(literalTail(size)) });
    const expected =
      size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : size;
    expect(
      unpackManifest({ ...input, total_file_size: size })[0]!.file_size
    ).toBe(expected);
  });

  it("promotes delta sizes and totals without losing precision", () => {
    const sizes = [(1n << 53n) - 1n, 1n << 53n, (1n << 53n) + 1n];
    const total = sizes.reduce((sum, size) => sum + size, 0n);
    const input = packet({
      count: 3,
      flags: 0x80,
      names: block(bytes(lp("a"), lp("b"), lp("c"))),
      tails: block(
        bytes(literalTail(sizes[0]!), literalTail(1), literalTail(1))
      )
    });
    expect(
      unpackManifest({ ...input, total_file_size: total }).map(
        (row) => row.file_size
      )
    ).toEqual([Number.MAX_SAFE_INTEGER, 1n << 53n, (1n << 53n) + 1n]);
    expect(() =>
      unpackManifest({ ...input, total_file_size: total - 1n })
    ).toThrow(ManifestPackingError);
    const entries = sizes.map((size, index) => ({
      ...entry,
      file_name: String(index),
      file_size: size
    }));
    const packed = packManifest(entries, { ...raw, fileSizeMode: "delta" });
    expect(packed.total_file_size).toBe(total);
    expect(unpackManifest(packed)).toEqual(expectedEntries(entries));
  });

  it("uses bigint when the sum exceeds the safe-number range", () => {
    const entries = [
      { ...entry, file_size: Number.MAX_SAFE_INTEGER },
      { ...entry, file_size: 1 }
    ];
    expect(packManifest(entries).total_file_size).toBe(
      BigInt(Number.MAX_SAFE_INTEGER) + 1n
    );
  });

  it("decodes nonnegative deltas after stable filename sorting", () => {
    const entries = [
      { ...entry, file_name: "c", file_size: 129 },
      { ...entry, file_name: "a", file_size: 1 },
      { ...entry, file_name: "b", file_size: 1 }
    ];
    const packed = packManifest(entries, { ...raw, fileSizeMode: "delta" });
    expect(inspectPacket(packed.manifest).flags & 0x80).toBe(0x80);
    expect(unpackManifest(packed)).toEqual(expectedEntries(entries));
    expect(
      unpackManifest(
        packet({
          count: 2,
          flags: 0x80,
          names: block(bytes(lp("a"), lp("b"))),
          tails: block(bytes(literalTail(127), literalTail(1)))
        })
      ).map((row) => row.file_size)
    ).toEqual([127, 128]);
  });

  it("rejects negative deltas induced by sorting", () => {
    expect(() =>
      packManifest(
        [
          { ...entry, file_name: "z", file_size: 1 },
          { ...entry, file_name: "a", file_size: 2 }
        ],
        { fileSizeMode: "delta" }
      )
    ).toThrow(ManifestPackingError);
  });
});
