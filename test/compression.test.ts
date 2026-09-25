import { brotliCompressSync, constants, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  packManifest,
  unpackManifest,
  type Compression
} from "../src/index.js";
import {
  expectedEntries,
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
  uint
} from "../fixtures/wire.js";

const codecs = ["none", "brotli", "zstd"] as const;

function completeBlockLength(
  item: ReturnType<typeof inspectPacket>["blocks"][number]
): number {
  return (
    1 +
    uint(item.rawLength).length +
    uint(item.storedLength).length +
    item.storedLength
  );
}

describe("independent codec interoperability", () => {
  it.each([
    ["single segment", [0x20, 2]],
    ["unspecified content size", [0, 0]],
    ["ignored unused bit", [0x30, 2]],
    ["four-byte content size", [0xa0, 2, 0, 0, 0]],
    ["eight-byte content size", [0xe0, 2, 0, 0, 0, 0, 0, 0, 0]],
    ["zero one-byte dictionary id", [0x21, 0, 2]],
    ["zero two-byte dictionary id", [0x22, 0, 0, 2]],
    ["zero four-byte dictionary id", [0x23, 0, 0, 0, 0, 2]]
  ] as const)("decodes a hand-built Zstandard frame: %s", (_, header) => {
    // RFC 8878: a two-byte raw block with the last-block flag set.
    const frame = bytes([0x28, 0xb5, 0x2f, 0xfd], header, [17, 0, 0, 1, 97]);
    const input = packet({ names: block(frame, 2, 2) });
    expect(unpackManifest(input)[0]!.file_name).toBe("a");
  });

  it("decodes Zstandard content sizes with the two-byte offset", () => {
    const name = "a".repeat(258);
    const names = lp(name);
    expect(names.length).toBe(260);
    const frame = bytes([0x28, 0xb5, 0x2f, 0xfd, 0x60, 4, 0, 33, 8, 0], names);
    expect(
      unpackManifest(packet({ names: block(frame, 2, 260) }))[0]!.file_name
    ).toBe(name);
  });

  it("decodes multiple blocks within one Zstandard frame", () => {
    const frame = bytes([
      0x28, 0xb5, 0x2f, 0xfd, 0x20, 2, 8, 0, 0, 1, 9, 0, 0, 97
    ]);
    expect(
      unpackManifest(packet({ names: block(frame, 2, 2) }))[0]!.file_name
    ).toBe("a");
  });

  it("decodes a Zstandard run-length block", () => {
    const frame = bytes([0x28, 0xb5, 0x2f, 0xfd, 0x20, 98, 19, 3, 0, 97]);
    expect(
      unpackManifest(packet({ names: block(frame, 2, 98) }))[0]!.file_name
    ).toBe("a".repeat(97));
  });

  it("accepts and verifies a native Zstandard checksum", () => {
    const names = lp("a");
    const frame = zstdCompressSync(names, {
      params: { [constants.ZSTD_c_checksumFlag]: 1 }
    });
    const input = packet({ names: block(frame, 2, names.length) });
    expect(unpackManifest(input)[0]!.file_name).toBe("a");
    const corrupted = frame.slice();
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    expect(() =>
      unpackManifest(packet({ names: block(corrupted, 2, names.length) }))
    ).toThrow();
  });

  it.each(
    codecs.flatMap((filenames) =>
      codecs.map((metadata) => [filenames, metadata] as const)
    )
  )("round-trips filename %s and metadata %s", (filenames, metadata) => {
    const entries = syntheticManifest(64);
    const packed = packManifest(entries, {
      compression: { filenames, metadata }
    });
    const inspected = inspectPacket(packed.manifest);
    expect(inspected.blocks.map((item) => item.codec)).toEqual([
      codecs.indexOf(filenames),
      codecs.indexOf(metadata)
    ]);
    expect(unpackManifest(packed)).toEqual(expectedEntries(entries));
  });

  it.each([1, 2])(
    "decodes independently compressed codec %i blocks",
    (codec) => {
      const compress = codec === 1 ? brotliCompressSync : zstdCompressSync;
      const names = lp("a");
      const tails = literalTail();
      const input = packet({
        names: block(compress(names), codec, names.length),
        tails: block(compress(tails), codec, tails.length)
      });
      expect(unpackManifest(input)).toEqual([
        { file_name: "a", s3_path: "p", file_hash: "x", file_size: 1 }
      ]);
    }
  );

  it.each([1, 2])("decodes codec %i empty streams", (codec) => {
    const compress = codec === 1 ? brotliCompressSync : zstdCompressSync;
    const compressed = block(compress(new Uint8Array()), codec, 0);
    expect(
      unpackManifest(
        packet({ count: 0, flags: 0x30, names: compressed, tails: compressed })
      )
    ).toEqual([]);
  });

  it("decodes all packed flag bits together", () => {
    const headers = bytes(
      lp(syntheticContext.org_id),
      lp(syntheticContext.app_id),
      lp(syntheticContext.version_name),
      lp("session")
    );
    const input = packet({
      flags: 0xff,
      headers,
      names: block(bytes(uint(0), [97, 0])),
      tails: block(bytes([2], uint(1), [3], lp("x")))
    });
    expect(unpackManifest(input)).toEqual([
      {
        file_name: "a",
        s3_path: syntheticDeltaPath("a", "x", "session"),
        file_hash: "x",
        file_size: 1
      }
    ]);
  });
});

describe("deterministic writer selection", () => {
  it.each([1, 100, 1000])(
    "selects complete filename frames with documented tie ordering (%i rows)",
    (count) => {
      const entries = syntheticManifest(count, {
        hashKind: "sha256",
        pathMode: "legacy"
      });
      const candidates = (["raw", "prefix"] as const).flatMap(
        (filenameTransform, transform) =>
          (["none", "brotli"] as const).map((filenames) => {
            const packed = packManifest(entries, {
              filenameTransform,
              compression: { filenames, metadata: "none" }
            });
            const candidate = inspectPacket(packed.manifest).blocks[0]!;
            return {
              length: completeBlockLength(candidate),
              transform,
              codec: candidate.codec
            };
          })
      );
      candidates.sort(
        (left, right) =>
          left.length - right.length ||
          left.transform - right.transform ||
          left.codec - right.codec
      );
      const selected = inspectPacket(
        packManifest(entries, { compression: { metadata: "none" } }).manifest
      );
      expect({
        length: completeBlockLength(selected.blocks[0]!),
        transform: (selected.flags >> 6) & 1,
        codec: selected.blocks[0]!.codec
      }).toEqual(candidates[0]);
    }
  );

  it.each([1, 100, 1000])(
    "selects complete metadata frames with documented tie ordering (%i rows)",
    (count) => {
      const entries = syntheticManifest(count, { pathMode: "literal" });
      const candidates = codecs.map((metadata: Compression) => {
        const candidate = inspectPacket(
          packManifest(entries, {
            compression: { filenames: "none", metadata }
          }).manifest
        ).blocks[1]!;
        return {
          length: completeBlockLength(candidate),
          codec: candidate.codec
        };
      });
      candidates.sort(
        (left, right) => left.length - right.length || left.codec - right.codec
      );
      const selected = inspectPacket(
        packManifest(entries, { compression: { filenames: "none" } }).manifest
      ).blocks[1]!;
      expect({
        length: completeBlockLength(selected),
        codec: selected.codec
      }).toEqual(candidates[0]);
    }
  );

  it("chooses raw transform and no compression for an empty tie", () => {
    const inspected = inspectPacket(packManifest([]).manifest);
    expect(inspected.flags & 0x40).toBe(0);
    expect(inspected.blocks.map((item) => item.codec)).toEqual([0, 0]);
  });

  it("produces identical packets for repeat calls without depending on input identity", () => {
    const entries = syntheticManifest(256);
    const first = packManifest(entries);
    const second = packManifest(entries.map((entry) => ({ ...entry })));
    expect(second.manifest).toEqual(first.manifest);
    expect(second.payload_hash).toEqual(first.payload_hash);
  });
});
