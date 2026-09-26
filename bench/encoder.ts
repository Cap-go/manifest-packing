import {
  packManifest,
  type Compression,
  type PackManifestOptions
} from "../src/index.js";
import { expectedEntries, syntheticContext } from "../fixtures/synthetic.js";
import { rowsFor } from "./fixture.js";

// Bundled into an ephemeral module, then executed by Node (not Bun/workerd).
export function encodeFixture(
  name: string,
  compression: Compression,
  transform: PackManifestOptions["filenameTransform"],
  sizes: PackManifestOptions["fileSizeMode"]
) {
  const rows = rowsFor(name, "monotonic");
  const start = performance.now();
  const packet = packManifest(rows, {
    context: syntheticContext,
    filenameTransform: transform,
    fileSizeMode: sizes,
    compression: { filenames: compression, metadata: compression }
  });
  return {
    prepared: {
      name,
      count: rows.length,
      compression,
      transform,
      sizeMode: sizes,
      sizeCorpus: "monotonic",
      encoder: "node",
      packetBytes: packet.manifest.byteLength,
      jsonBytes: Buffer.byteLength(JSON.stringify(expectedEntries(rows))),
      encodeMs: performance.now() - start
    },
    packet: {
      ...packet,
      manifest: Buffer.from(packet.manifest).toString("base64"),
      payload_hash: Buffer.from(packet.payload_hash).toString("base64"),
      total_file_size: packet.total_file_size?.toString()
    }
  };
}
