import { createHash } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import { unpackManifest, type UnpackManifestInput } from "../src/index.js";

// Local-only benchmark state. This Worker is never deployed or used for traffic.
let prepared: UnpackManifestInput | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return Response.json({
        ready: true,
        singleShotHash: typeof nodeCrypto.hash
      });
    if (url.pathname === "/prepare" && request.method === "POST") {
      const declaredLength = Number(request.headers.get("content-length"));
      if (!(declaredLength > 0 && declaredLength <= 16 * 1024 * 1024))
        return Response.json(
          { error: "Invalid bounded fixture" },
          { status: 400 }
        );
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length !== declaredLength)
        throw new Error("Fixture length mismatch");
      prepared = {
        format_version: 0,
        entry_count: Number(url.searchParams.get("count")),
        total_file_size: BigInt(url.searchParams.get("total") ?? "0"),
        payload_hash: Buffer.from(url.searchParams.get("hash") ?? "", "hex"),
        manifest: bytes
      };
      return Response.json({ ready: true, bytes: bytes.length });
    }
    if (url.pathname !== "/decode" || !prepared)
      return Response.json({ error: "Not prepared" }, { status: 400 });
    const start = performance.now();
    const rows = unpackManifest(prepared);
    const elapsedMs = performance.now() - start;
    if (!(elapsedMs > 0)) throw new Error("Attach inspector for a live clock");
    // Verification happens after timing, and is omitted during CPU profiling.
    const fingerprint = url.searchParams.has("verify")
      ? createHash("sha256").update(JSON.stringify(rows)).digest("hex")
      : undefined;
    const stages = (
      globalThis as typeof globalThis & {
        __manifestProfile?: Record<string, number>;
      }
    ).__manifestProfile;
    return Response.json({
      elapsedMs,
      entries: rows.length,
      fingerprint,
      stages
    });
  }
};
