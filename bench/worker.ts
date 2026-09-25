import * as zlib from "node:zlib";
import {
  ManifestPackingError,
  packManifest,
  unpackManifest,
  type Compression,
  type DecodedManifestEntry,
  type PackedManifest
} from "../src/index.js";
import {
  expectedEntries,
  syntheticContext,
  syntheticBytes
} from "../fixtures/synthetic.js";
import { adversarialPackets } from "../fixtures/adversarial.js";
import { cases, fingerprint, rowsFor } from "./fixture.js";

const MIB = 1024 * 1024;

function nativeResult(value: unknown): {
  buffer: Uint8Array;
  engine: { bytesWritten: number };
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("buffer" in value) ||
    !(value.buffer instanceof Uint8Array) ||
    !("engine" in value) ||
    typeof value.engine !== "object" ||
    value.engine === null ||
    !("bytesWritten" in value.engine) ||
    typeof value.engine.bytesWritten !== "number"
  )
    throw new Error("Native info result missing");
  return value as { buffer: Uint8Array; engine: { bytesWritten: number } };
}

// This local-only diagnostic intentionally shares one synthetic packet across
// requests, matching a retained cache. Never put production request data here.
let fixture:
  { packet: PackedManifest; fingerprint: string; json: string } | undefined;
// Scalar admission accounting only: reserve before decode and release only when
// the request has finished consuming its output. 24 MiB is left for the host app.
let reservedDecodeBytes = 0;
const sharedDecodeBudget = 72 * MIB;

function checkedInteger(url: URL, key: string, fallback: number, max: number) {
  const value = Number(url.searchParams.get(key) ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`Invalid ${key}`);
  return value;
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    min: sorted[0],
    max: sorted[sorted.length - 1]
  };
}

async function checkpoint(label: string, held: unknown) {
  console.log(JSON.stringify({ checkpoint: label }));
  // Inspector collection is intentionally outside all timing measurements.
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (held === undefined) throw new Error("Lost checkpoint reference");
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return Response.json({ ready: true });
      if (url.pathname === "/runtime-probe") {
        const payload = Buffer.from("synthetic codec probe ".repeat(100));
        const result: Record<string, unknown> = {};
        for (const codec of ["brotli", "zstd"] as const) {
          try {
            const encode =
              codec === "brotli"
                ? zlib.brotliCompressSync
                : zlib.zstdCompressSync;
            const decode =
              codec === "brotli"
                ? zlib.brotliDecompressSync
                : zlib.zstdDecompressSync;
            const packed = encode(payload);
            const decoded = decode(packed, {
              info: true,
              maxOutputLength: payload.length
            });
            const info: unknown = decoded;
            result[codec] =
              typeof info === "object" &&
              info !== null &&
              "buffer" in info &&
              "engine" in info
                ? {
                    info: true,
                    engine: Object.getOwnPropertyNames(info.engine),
                    bytesWritten: Reflect.get(
                      Object(info.engine),
                      "bytesWritten"
                    ),
                    packedLength: packed.length
                  }
                : { info: false };
          } catch (error) {
            result[codec] = {
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
        for (const size of [
          16_000, 16_384, 16_385, 65_536, 262_144, 1_048_576, 4_194_304
        ]) {
          const raw = syntheticBytes(size);
          for (const codec of [
            "brotli-names",
            "brotli-metadata",
            "zstd",
            "zstd-full-chunk"
          ] as const) {
            let stage = "compress";
            try {
              const output = codec.startsWith("zstd")
                ? zlib.zstdCompressSync(raw, {
                    ...(codec === "zstd-full-chunk"
                      ? { chunkSize: size + (size >>> 8) + 64 }
                      : {}),
                    params: {
                      [zlib.constants.ZSTD_c_compressionLevel]: 3,
                      [zlib.constants.ZSTD_c_windowLog]: 22
                    }
                  })
                : zlib.brotliCompressSync(raw, {
                    params: {
                      [zlib.constants.BROTLI_PARAM_QUALITY]:
                        codec === "brotli-names" ? 11 : 6,
                      [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
                      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size
                    }
                  });
              stage = "decompress";
              const decoded = nativeResult(
                codec.startsWith("zstd")
                  ? zlib.zstdDecompressSync(output, {
                      info: true,
                      maxOutputLength: size,
                      ...(codec === "zstd-full-chunk"
                        ? { chunkSize: size }
                        : {}),
                      params: { [zlib.constants.ZSTD_d_windowLogMax]: 24 }
                    })
                  : zlib.brotliDecompressSync(output, {
                      info: true,
                      maxOutputLength: size
                    })
              );
              result[`${codec}-${size}`] = {
                packedBytes: output.length,
                decodedBytes: decoded.buffer.length,
                consumedBytes: decoded.engine.bytesWritten,
                correct: Buffer.compare(raw, decoded.buffer) === 0
              };
            } catch (error) {
              result[`${codec}-${size}`] = {
                stage,
                error: error instanceof Error ? error.message : String(error)
              };
            }
          }
        }
        for (const [label, params] of [
          ["default", {}],
          ["level-only", { [zlib.constants.ZSTD_c_compressionLevel]: 3 }],
          ["window-only", { [zlib.constants.ZSTD_c_windowLog]: 22 }]
        ] as const) {
          try {
            const raw = syntheticBytes(65_536);
            const output = zlib.zstdCompressSync(raw, { params });
            result[`zstd-params-${label}`] = { packedBytes: output.length };
          } catch (error) {
            result[`zstd-params-${label}`] = {
              error: error instanceof Error ? error.message : String(error)
            };
          }
          try {
            const raw = syntheticBytes(65_536);
            const output = nativeResult(
              zlib.zstdCompressSync(raw, { info: true, params })
            );
            result[`zstd-info-${label}`] = {
              packedBytes: output.buffer.length,
              consumedBytes: output.engine.bytesWritten
            };
          } catch (error) {
            result[`zstd-info-${label}`] = {
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
        return Response.json(result);
      }
      if (url.pathname === "/adversarial") {
        const results = adversarialPackets().map((test) => {
          try {
            unpackManifest(test.input, test.options);
            return {
              name: test.name,
              passed: false,
              code: "UNEXPECTED_ACCEPT"
            };
          } catch (error) {
            const code =
              error instanceof ManifestPackingError
                ? error.code
                : "UNEXPECTED_ERROR_TYPE";
            return {
              name: test.name,
              passed: test.expectedCodes.some((expected) => expected === code),
              code,
              message: error instanceof Error ? error.message : String(error)
            };
          }
        });
        return Response.json({
          passed: results.every((result) => result.passed),
          cases: results.length,
          results
        });
      }
      if (url.pathname === "/import" && request.method === "POST") {
        const name = url.searchParams.get("case") ?? "maximum";
        const wire = (await request.json()) as Omit<
          PackedManifest,
          "manifest" | "payload_hash" | "total_file_size"
        > & { manifest: string; payload_hash: string; total_file_size: string };
        const expected = expectedEntries(
          rowsFor(name, "monotonic")
        ) as DecodedManifestEntry[];
        fixture = {
          packet: {
            ...wire,
            manifest: Buffer.from(wire.manifest, "base64"),
            payload_hash: Buffer.from(wire.payload_hash, "base64"),
            total_file_size: BigInt(wire.total_file_size)
          },
          fingerprint: fingerprint(expected),
          json: JSON.stringify(expected)
        };
        return Response.json({ imported: true, name, count: expected.length });
      }
      if (url.pathname === "/prepare") {
        const name = url.searchParams.get("case") ?? "maximum";
        const test = cases[name];
        if (!test) throw new Error("Unknown case");
        const compression = url.searchParams.get("codec") ?? "auto";
        if (!["auto", "none", "brotli", "zstd"].includes(compression))
          throw new Error("Unknown codec");
        const transform = url.searchParams.get("transform") ?? "auto";
        if (
          transform !== "auto" &&
          transform !== "raw" &&
          transform !== "prefix"
        )
          throw new Error("Unknown transform");
        const sizeMode = url.searchParams.get("sizes") ?? "absolute";
        if (sizeMode !== "absolute" && sizeMode !== "delta")
          throw new Error("Unknown size mode");
        const sizeCorpus =
          url.searchParams.get("sizeCorpus") ??
          (sizeMode === "delta" ? "monotonic" : "mixed");
        const rows = rowsFor(name, sizeCorpus);
        const start = performance.now();
        const packet = packManifest(rows, {
          context: syntheticContext,
          filenameTransform: transform,
          fileSizeMode: sizeMode,
          compression: {
            filenames: compression as Compression,
            metadata: compression as Compression
          }
        });
        const encodeMs = performance.now() - start;
        const expected = expectedEntries(rows) as DecodedManifestEntry[];
        const json = JSON.stringify(expected);
        fixture = { packet, fingerprint: fingerprint(expected), json };
        return Response.json({
          name,
          encoder: "workerd",
          count: test.count,
          compression,
          transform,
          sizeMode,
          sizeCorpus,
          packetBytes: packet.manifest.byteLength,
          jsonBytes: new TextEncoder().encode(json).byteLength,
          encodeMs
        });
      }
      if (!fixture) throw new Error("Call /prepare first");
      const current = fixture;
      if (url.pathname === "/time") {
        const samples = checkedInteger(url, "samples", 9, 100);
        const batch = checkedInteger(url, "batch", 20, 2_000);
        const firstStart = performance.now();
        const first = unpackManifest(current.packet);
        const firstDecodeMs = performance.now() - firstStart;
        if (fingerprint(first) !== current.fingerprint)
          throw new Error("Decoded fields differ from fixture");
        const times: number[] = [];
        const jsonTimes: number[] = [];
        let sink = 0;
        for (let warm = 0; warm < 3; warm++) {
          sink += unpackManifest(current.packet).length;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        for (let sample = 0; sample < samples; sample++) {
          let start = performance.now();
          for (let i = 0; i < batch; i++)
            sink += unpackManifest(current.packet).length;
          times.push((performance.now() - start) / batch);
          start = performance.now();
          for (let i = 0; i < batch; i++)
            sink += (JSON.parse(current.json) as unknown[]).length;
          jsonTimes.push((performance.now() - start) / batch);
          // Yield outside the timed batch so the runtime can schedule normal GC
          // and the inspector can observe memory between repeated allocations.
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return Response.json({
          firstDecodeMs,
          warmupDecodes: 3,
          batchIterations: batch,
          yieldBetweenBatchesMs: 5,
          warmDecodeMs: summarize(times),
          jsonParseMs: summarize(jsonTimes),
          sink,
          correct: true
        });
      }
      if (url.pathname === "/memory") {
        const repeats = checkedInteger(url, "repeats", 8, 16);
        const held: DecodedManifestEntry[][] = [];
        await checkpoint("before-decode", current.packet);
        for (let index = 0; index < repeats; index++) {
          held.push(unpackManifest(current.packet));
          await checkpoint(`retained-${index + 1}`, held);
        }
        const count = held.reduce((sum, rows) => sum + rows.length, 0);
        return Response.json({
          retainedCopies: held.length,
          count,
          correct: fingerprint(held[held.length - 1]) === current.fingerprint
        });
      }
      if (url.pathname === "/hold") {
        const guarded = url.searchParams.get("guarded") === "1";
        if (
          guarded &&
          reservedDecodeBytes + sharedDecodeBudget > sharedDecodeBudget
        ) {
          return Response.json(
            {
              admitted: false,
              reason: "Shared isolate decode budget reserved"
            },
            { status: 429 }
          );
        }
        if (guarded) reservedDecodeBytes += sharedDecodeBudget;
        try {
          const held = unpackManifest(
            current.packet,
            guarded
              ? { limits: { maxMemoryBytes: sharedDecodeBudget } }
              : undefined
          );
          await new Promise((resolve) =>
            setTimeout(resolve, checkedInteger(url, "holdMs", 500, 10_000))
          );
          return Response.json({
            admitted: true,
            count: held.length,
            correct: fingerprint(held) === current.fingerprint
          });
        } finally {
          if (guarded) reservedDecodeBytes -= sharedDecodeBudget;
        }
      }
      if (url.pathname === "/guards") {
        const outcomes: Record<string, { code: string; message?: string }> = {};
        for (const [name, limits] of [
          ["entry-count", { maxEntries: 1 }],
          ["packet-bytes", { maxPacketBytes: 1 }],
          ["block-bytes", { maxBlockBytes: 1 }],
          ["string-bytes", { maxStringBytes: 1 }],
          ["decoded-bytes", { maxDecodedBytes: 1 }],
          ["memory-bytes", { maxMemoryBytes: 1 }]
        ] as const) {
          try {
            unpackManifest(current.packet, { limits });
            outcomes[name] = { code: "UNEXPECTED_ACCEPT" };
          } catch (error) {
            outcomes[name] = {
              code:
                error instanceof ManifestPackingError
                  ? error.code
                  : "UNEXPECTED_ERROR_TYPE",
              message: error instanceof Error ? error.message : String(error)
            };
          }
        }
        return Response.json({
          passed: Object.values(outcomes).every(
            (value) => value.code === "RESOURCE_LIMIT"
          ),
          outcomes,
          defaultMemoryBudget: 96 * MIB
        });
      }
      return Response.json({ error: "Unknown route" }, { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
