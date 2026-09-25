import { createHash } from "node:crypto";

import type { ManifestEntry } from "../src/index.js";

/** Invented identifiers used only by tests and local benchmarks. */
export const syntheticContext = {
  org_id: "synthetic-org",
  app_id: "example.synthetic.app",
  version_name: "synthetic-v1"
} as const;

export type SyntheticPathMode = "legacy" | "delta" | "literal" | "mixed";

export interface SyntheticOptions {
  readonly pathMode?: SyntheticPathMode;
  readonly sessionKey?: string;
  readonly seed?: number;
  readonly hashKind?: "mixed" | "sha256" | "rsa-v2" | "rsa-v3" | "literal";
  readonly filenames?: "ascii" | "utf8" | "long";
}

export function syntheticDeltaPath(
  fileName: string,
  hash: string,
  sessionKey = "",
  context: { org_id: string; app_id: string } = syntheticContext
): string {
  const digest = createHash("sha256").update(hash, "utf8").digest("hex");
  const session = sessionKey
    ? `${Buffer.from(sessionKey, "utf8").toString("hex")}/`
    : "";
  const encoded = fileName.split("/").map(encodeURIComponent).join("/");
  return `orgs/${context.org_id}/apps/${context.app_id}/delta/${session}${digest}_${encoded}`;
}

/** Deterministic high-entropy bytes, containing no production data. */
export function syntheticBytes(length: number, seed = 1): Uint8Array {
  let state = seed >>> 0 || 1;
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state & 0xff;
  }
  return result;
}

/** Repeatable rows covering directory repetition, all hash kinds, and path modes. */
export function syntheticManifest(
  count: number,
  options: SyntheticOptions = {}
): ManifestEntry[] {
  const seed = options.seed ?? 7;
  return Array.from({ length: count }, (_, index) => {
    const namePrefix =
      options.filenames === "utf8"
        ? "assets/日本語/café/🧪"
        : options.filenames === "long"
          ? `assets/${"synthetic-directory/".repeat(12)}`
          : "assets";
    const fileName = `${namePrefix}/group-${String(index % 31).padStart(2, "0")}/chunk-${String(index).padStart(7, "0")}.js`;
    const hashKind =
      options.hashKind === undefined || options.hashKind === "mixed"
        ? (["sha256", "rsa-v2", "rsa-v3", "literal"] as const)[index % 4]
        : options.hashKind;
    const hashBytes = syntheticBytes(
      hashKind === "sha256" ? 32 : 256,
      seed + index
    );
    const hash =
      hashKind === "sha256"
        ? Buffer.from(hashBytes).toString("hex")
        : hashKind === "rsa-v2"
          ? Buffer.from(hashBytes).toString("base64")
          : hashKind === "rsa-v3"
            ? Buffer.from(hashBytes).toString("hex")
            : `synthetic-literal-hash-${seed}-${index}`;
    const mode =
      options.pathMode === undefined || options.pathMode === "mixed"
        ? (["legacy", "delta", "literal"] as const)[index % 3]
        : options.pathMode;
    const path =
      mode === "delta"
        ? syntheticDeltaPath(fileName, hash, options.sessionKey)
        : mode === "legacy"
          ? `orgs/${syntheticContext.org_id}/apps/${syntheticContext.app_id}/${syntheticContext.version_name}/${fileName}`
          : `synthetic-storage/${fileName}`;
    return {
      id: index + 1,
      app_version_id: 1,
      file_name: fileName,
      s3_path: path,
      file_hash: hash,
      file_size: (index * 7919 + seed) % 1_000_003
    };
  });
}

/** The protocol preserves these four fields, sorted stably by UTF-8 filename. */
export function expectedEntries(entries: readonly ManifestEntry[]) {
  return entries
    .map(({ file_name, s3_path, file_hash, file_size }) => ({
      file_name,
      s3_path,
      file_hash,
      file_size:
        typeof file_size === "bigint" &&
        file_size <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(file_size)
          : file_size
    }))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.file_name), Buffer.from(right.file_name))
    );
}
