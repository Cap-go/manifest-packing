import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packManifest } from "../src/index.js";
import { Reader } from "../src/binary.js";
import { readBlock } from "../src/compression.js";
import { readHeaderStrings } from "../src/paths.js";
import {
  expectedEntries,
  syntheticManifest,
  type SyntheticOptions
} from "../fixtures/synthetic.js";

const scenarios: Record<string, SyntheticOptions> = {
  "rsa-v2-delta": { hashKind: "rsa-v2", pathMode: "delta" },
  "rsa-v3-delta": { hashKind: "rsa-v3", pathMode: "delta" },
  "rsa-v3-delta-metadata-none": { hashKind: "rsa-v3", pathMode: "delta" },
  "rsa-v3-delta-metadata-brotli": { hashKind: "rsa-v3", pathMode: "delta" },
  "rsa-v3-delta-metadata-zstd": { hashKind: "rsa-v3", pathMode: "delta" },
  "rsa-v2-legacy": { hashKind: "rsa-v2", pathMode: "legacy" },
  "rsa-v3-legacy": { hashKind: "rsa-v3", pathMode: "legacy" },
  "rsa-v2-mixed": { hashKind: "rsa-v2", pathMode: "mixed" },
  "rsa-v3-mixed": { hashKind: "rsa-v3", pathMode: "mixed" },
  "rsa-v2-mixed-metadata-brotli": { hashKind: "rsa-v2", pathMode: "mixed" },
  "rsa-v3-mixed-metadata-brotli": { hashKind: "rsa-v3", pathMode: "mixed" },
  "rsa-v3-mixed-metadata-none": { hashKind: "rsa-v3", pathMode: "mixed" },
  "sha256-delta": { hashKind: "sha256", pathMode: "delta" },
  "unicode-delta": { hashKind: "sha256", pathMode: "delta", filenames: "utf8" },
  "long-delta": { hashKind: "sha256", pathMode: "delta", filenames: "long" }
};
const destination = process.argv[2];
if (!destination) throw new Error("Missing fixture destination");
await mkdir(destination, { recursive: true });
const metadata = [];
for (const [name, options] of Object.entries(scenarios)) {
  const rows = syntheticManifest(10_000, options);
  const codec = name.endsWith("-none")
    ? "none"
    : name.endsWith("-brotli")
      ? "brotli"
      : name.endsWith("-zstd")
        ? "zstd"
        : "auto";
  const packed = packManifest(rows, { compression: { metadata: codec } });
  const reader = new Reader(packed.manifest);
  reader.byte();
  reader.byte();
  reader.uint(10_000);
  readHeaderStrings(reader, reader.byte(), 1024 * 1024);
  const names = readBlock(reader, 16 * 1024 * 1024);
  const tails = readBlock(reader, 16 * 1024 * 1024);
  reader.end();
  await writeFile(join(destination, `${name}.bin`), packed.manifest);
  metadata.push({
    name,
    count: packed.entry_count,
    total: packed.total_file_size.toString(),
    hash: Buffer.from(packed.payload_hash).toString("hex"),
    packetBytes: packed.manifest.length,
    blocks: {
      filenames: {
        codec: names.codec,
        rawBytes: names.rawLength,
        storedBytes: names.data.length
      },
      metadata: {
        codec: tails.codec,
        rawBytes: tails.rawLength,
        storedBytes: tails.data.length
      }
    },
    fingerprint: createHash("sha256")
      .update(JSON.stringify(expectedEntries(rows)))
      .digest("hex")
  });
}
await writeFile(join(destination, "metadata.json"), JSON.stringify(metadata));
