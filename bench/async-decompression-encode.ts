import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import { syntheticManifest, syntheticContext } from "../fixtures/synthetic.js";
import { packManifest } from "../src/index.js";
import { inspectPacket } from "../fixtures/wire.js";

const rows = syntheticManifest(10_000, { hashKind: "rsa-v3" });
const packed = packManifest(rows, {
  context: syntheticContext,
  filenameTransform: "prefix",
  compression: { filenames: "none", metadata: "none" }
});
const blocks = inspectPacket(packed.manifest).blocks;
process.stdout.write(
  JSON.stringify({
    entryCount: rows.length,
    variants: ["brotli", "zstd"].map((codec) => ({
      codec,
      blocks: blocks.map((block, index) => {
        const bytes =
          codec === "brotli"
            ? zlib.brotliCompressSync(block.stored, {
                params: {
                  [zlib.constants.BROTLI_PARAM_QUALITY]: index === 0 ? 11 : 6
                }
              })
            : zlib.zstdCompressSync(block.stored, {
                params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 }
              });
        return {
          data: Buffer.from(bytes).toString("base64"),
          rawLength: block.rawLength,
          digest: createHash("sha256").update(block.stored).digest("hex")
        };
      })
    }))
  })
);
