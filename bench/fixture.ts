import { createHash } from "node:crypto";
import type { DecodedManifestEntry } from "../src/index.js";
import {
  expectedEntries,
  syntheticManifest,
  type SyntheticOptions
} from "../fixtures/synthetic.js";

export const cases: Record<
  string,
  { count: number; options: SyntheticOptions }
> = {
  small: { count: 10, options: { hashKind: "sha256" } },
  median: { count: 1_000, options: { hashKind: "sha256" } },
  p95: { count: 5_000, options: { hashKind: "sha256" } },
  maximum: { count: 10_000, options: { hashKind: "sha256" } },
  "rsa-v2": { count: 10_000, options: { hashKind: "rsa-v2" } },
  "rsa-v3": { count: 10_000, options: { hashKind: "rsa-v3" } },
  utf8: { count: 10_000, options: { hashKind: "sha256", filenames: "utf8" } },
  "long-paths": {
    count: 10_000,
    options: { hashKind: "sha256", filenames: "long" }
  }
};

export function fingerprint(entries: readonly DecodedManifestEntry[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(entries, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value
      )
    )
    .digest("hex");
}

export function rowsFor(name: string, sizeCorpus: string) {
  const test = cases[name];
  if (!test) throw new Error("Unknown case");
  if (sizeCorpus !== "monotonic" && sizeCorpus !== "mixed")
    throw new Error("Unknown size corpus");
  const rows = syntheticManifest(test.count, test.options);
  if (sizeCorpus === "monotonic") {
    const sizes = new Map(
      expectedEntries(rows).map((row, index) => [row.file_name, index * 100])
    );
    for (const row of rows)
      Object.assign(row, { file_size: sizes.get(row.file_name) });
  }
  return rows;
}
