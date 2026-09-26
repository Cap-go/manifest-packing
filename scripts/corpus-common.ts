import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface IngestMetadata {
  status: "complete";
  counts: { manifest: number; app_versions: number; apps: number };
  dump_sha256: string;
  dump_bytes: number;
}

/** Errors deliberately contain no input values or paths. */
export function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

export function safeErrorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && /^[A-Z][A-Z_]{3,80}$/.test(error.message))
    return error.message;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z_]{3,80}$/.test(error.code)
  )
    return error.code;
  return fallback;
}

export function parseArguments(
  allowed: readonly string[]
): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    requireCondition(
      key &&
        allowed.includes(key) &&
        value &&
        !value.startsWith("--") &&
        !result.has(key),
      "INVALID_ARGUMENTS"
    );
    result.set(key, value);
  }
  return result;
}

export function requiredArgument(
  args: Map<string, string>,
  name: string
): string {
  const value = args.get(name);
  requireCondition(value, "MISSING_ARGUMENT");
  return value;
}

export async function fingerprint(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.partial`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  await rename(temporary, path);
}

/** Refuse private outputs inside this public checkout, including via symlinks. */
export async function privateDirectory(path: string): Promise<string> {
  requireCondition(isAbsolute(path), "PRIVATE_DIRECTORY_MUST_BE_ABSOLUTE");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const actual = await realpath(path);
  const checkout = await realpath(
    fileURLToPath(new URL("../", import.meta.url))
  );
  const rel = relative(checkout, actual);
  requireCondition(
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(rel),
    "PRIVATE_DIRECTORY_INSIDE_CHECKOUT"
  );
  return actual;
}

export async function validateIngestMetadata(
  value: unknown,
  dumpPath: string,
  expectedSha256: string
): Promise<IngestMetadata> {
  requireCondition(
    value !== null && typeof value === "object",
    "INVALID_INGEST_METADATA"
  );
  const metadata = value as IngestMetadata;
  requireCondition(metadata.status === "complete", "INCOMPLETE_INGEST");
  requireCondition(
    /^[0-9a-f]{64}$/.test(expectedSha256),
    "INVALID_EXPECTED_FINGERPRINT"
  );
  requireCondition(
    metadata.dump_sha256 === expectedSha256,
    "INGEST_FINGERPRINT_MISMATCH"
  );
  requireCondition(
    metadata.dump_bytes === (await stat(dumpPath)).size,
    "DUMP_SIZE_MISMATCH"
  );
  for (const table of ["manifest", "app_versions", "apps"] as const) {
    requireCondition(
      Number.isSafeInteger(metadata.counts?.[table]) &&
        metadata.counts[table] >= 0,
      "INVALID_INGEST_COUNTS"
    );
  }
  requireCondition(
    (await fingerprint(dumpPath)) === expectedSha256,
    "DUMP_FINGERPRINT_MISMATCH"
  );
  return metadata;
}

export async function ensureOutsideCheckout(path: string): Promise<string> {
  const directory = await privateDirectory(dirname(resolve(path)));
  return resolve(directory, path.split(/[\\/]/).at(-1)!);
}
