import { Buffer } from "node:buffer";
import { createHash, hash } from "node:crypto";
import { Worker } from "node:worker_threads";
import * as zlib from "node:zlib";
import { syntheticBytes } from "../fixtures/synthetic.js";

type Codec = "brotli" | "zstd";
interface Block {
  data: Buffer;
  rawLength: number;
  digest: string;
}
interface Info {
  buffer: Buffer;
  engine: { bytesWritten: number };
}
// Deliberately retained SYNTHETIC benchmark fixture; never production request state.
let variants: { codec: Codec; blocks: Block[] }[] = [];
let hashes: string[] = [];
let expectedHashes: string[] = [];
const encoder = new TextEncoder();

function info(value: unknown): Info {
  if (
    typeof value !== "object" ||
    value === null ||
    !("buffer" in value) ||
    !Buffer.isBuffer(value.buffer) ||
    !("engine" in value) ||
    typeof value.engine !== "object" ||
    value.engine === null ||
    !("bytesWritten" in value.engine) ||
    typeof value.engine.bytesWritten !== "number"
  )
    throw new Error("Native input consumption unavailable");
  return value as Info;
}

function options(block: Block, codec: Codec) {
  return {
    info: true,
    maxOutputLength: Math.max(1, block.rawLength),
    ...(codec === "zstd"
      ? { params: { [zlib.constants.ZSTD_d_windowLogMax]: 24 } }
      : {})
  };
}

function sync(block: Block, codec: Codec): Info {
  return info(
    codec === "brotli"
      ? zlib.brotliDecompressSync(block.data, options(block, codec))
      : zlib.zstdDecompressSync(block.data, options(block, codec))
  );
}

function asynchronous(block: Block, codec: Codec): Promise<Info> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, result: unknown) => {
      if (error) reject(error);
      else {
        try {
          resolve(info(result));
        } catch (failure) {
          reject(failure);
        }
      }
    };
    if (codec === "brotli")
      zlib.brotliDecompress(block.data, options(block, codec), callback);
    else zlib.zstdDecompress(block.data, options(block, codec), callback);
  });
}

function verify(result: Info, block: Block) {
  if (
    result.buffer.length !== block.rawLength ||
    result.engine.bytesWritten !== block.data.length ||
    createHash("sha256").update(result.buffer).digest("hex") !== block.digest
  )
    throw new Error("Decompression correctness failed");
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/prepare-hash") {
      const characters = Number(url.searchParams.get("characters"));
      if (![64, 344, 512].includes(characters))
        return Response.json({ error: "invalid hash length" }, { status: 400 });
      hashes = Array.from({ length: 10_000 }, (_, index) =>
        Buffer.from(
          syntheticBytes(characters === 64 ? 32 : 256, index + 7)
        ).toString(characters === 344 ? "base64" : "hex")
      );
      expectedHashes = hashes.map((value) =>
        createHash("sha256").update(value).digest("hex")
      );
      return Response.json({ count: hashes.length, characters });
    }
    if (url.pathname === "/hash") {
      const method = url.searchParams.get("method");
      const results: string[] = [];
      results.length = hashes.length;
      const hashInputScratch = Buffer.allocUnsafe(512);
      const hashInputView = hashInputScratch.subarray(
        0,
        hashes[0]?.length ?? 0
      );
      const webcrypto = async (value: string) =>
        Buffer.from(
          await crypto.subtle.digest("SHA-256", encoder.encode(value))
        ).toString("hex");
      const start = performance.now();
      if (method === "createHash")
        for (let index = 0; index < hashes.length; index++)
          results[index] = createHash("sha256")
            .update(hashes[index]!)
            .digest("hex");
      else if (method === "createHash-reuseBuffer")
        for (let index = 0; index < hashes.length; index++) {
          hashInputScratch.write(
            hashes[index]!,
            0,
            hashInputView.length,
            "utf8"
          );
          results[index] = createHash("sha256")
            .update(hashInputView)
            .digest("hex");
        }
      else if (method === "hash")
        for (let index = 0; index < hashes.length; index++)
          results[index] = hash("sha256", hashes[index]!, "hex");
      else if (method === "webcrypto-sequential")
        for (let index = 0; index < hashes.length; index++)
          results[index] = await webcrypto(hashes[index]!);
      else if (method === "webcrypto-batch32") {
        for (let start = 0; start < hashes.length; start += 32) {
          const batch = await Promise.all(
            hashes.slice(start, start + 32).map(webcrypto)
          );
          for (let offset = 0; offset < batch.length; offset++)
            results[start + offset] = batch[offset]!;
        }
      } else
        return Response.json({ error: "invalid hash method" }, { status: 400 });
      const elapsedMs = performance.now() - start;
      for (let index = 0; index < hashes.length; index++)
        if (results[index] !== expectedHashes[index])
          throw new Error("Hash correctness failed");
      return Response.json({
        method,
        elapsedMs,
        verifiedHashes: hashes.length
      });
    }
    if (url.pathname === "/prepare") {
      const length = Number(request.headers.get("content-length"));
      if (!Number.isInteger(length) || length <= 0 || length > 10_000_000)
        return Response.json(
          { error: "bounded synthetic input required" },
          { status: 400 }
        );
      const input = await request.json<{
        variants: {
          codec: Codec;
          blocks: { data: string; rawLength: number; digest: string }[];
        }[];
      }>();
      variants = input.variants.map((variant) => ({
        ...variant,
        blocks: variant.blocks.map((block) => ({
          ...block,
          data: Buffer.from(block.data, "base64")
        }))
      }));
      return Response.json({
        variants: variants.map(({ codec, blocks }) => ({
          codec,
          blocks: blocks.map(({ data, rawLength }) => ({
            rawLength,
            storedLength: data.length
          }))
        }))
      });
    }
    if (url.pathname === "/capabilities") {
      let workerError = "unexpectedly constructed";
      try {
        new Worker("", { eval: true });
      } catch (error) {
        workerError = String(error);
      }
      const consumption = [];
      for (const { codec, blocks } of variants) {
        const block = blocks[0]!;
        const result = await asynchronous(block, codec);
        verify(result, block);
        const appended = {
          ...block,
          data: Buffer.concat([block.data, Buffer.from([0])])
        };
        let trailing;
        try {
          trailing = {
            inputBytes: appended.data.length,
            bytesWritten: (await asynchronous(appended, codec)).engine
              .bytesWritten
          };
        } catch (error) {
          trailing = { rejected: String(error) };
        }
        consumption.push({
          codec,
          inputBytes: block.data.length,
          bytesWritten: result.engine.bytesWritten,
          trailing
        });
      }
      return Response.json({ workerError, consumption });
    }
    if (url.pathname === "/measure") {
      const variant = variants.find(
        ({ codec }) => codec === url.searchParams.get("codec")
      );
      const method = url.searchParams.get("method");
      if (
        !variant ||
        !["sync", "async-sequential", "async-all"].includes(method ?? "")
      )
        return Response.json({ error: "invalid case" }, { status: 400 });
      const start = performance.now();
      let results: Info[];
      if (method === "sync")
        results = variant.blocks.map((block) => sync(block, variant.codec));
      else if (method === "async-all")
        results = await Promise.all(
          variant.blocks.map((block) => asynchronous(block, variant.codec))
        );
      else {
        results = [];
        for (const block of variant.blocks)
          results.push(await asynchronous(block, variant.codec));
      }
      const elapsedMs = performance.now() - start;
      for (let index = 0; index < results.length; index++)
        verify(results[index]!, variant.blocks[index]!);
      return Response.json({
        codec: variant.codec,
        method,
        elapsedMs,
        verifiedBlocks: results.length
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
} satisfies ExportedHandler;
