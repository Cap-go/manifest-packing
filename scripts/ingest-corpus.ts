/** Stream a local PostgreSQL archive into a private, indexed SQLite corpus. */
import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import {
  atomicJson,
  fingerprint,
  parseArguments,
  privateDirectory,
  requireCondition,
  requiredArgument,
  safeErrorCode
} from "./corpus-common.ts";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const escapeBytes: Record<number, number> = {
  98: 8,
  102: 12,
  110: 10,
  114: 13,
  116: 9,
  118: 11,
  92: 92
};

/** PostgreSQL text COPY escaping, decoded before interpreting field contents. */
export function unescapeCopy(value: Buffer): Buffer | null {
  if (value.equals(Buffer.from("\\N"))) return null;
  if (!value.includes(92)) return value;
  const output = Buffer.allocUnsafe(value.length);
  let written = 0;
  for (let i = 0; i < value.length; i++) {
    let current = value[i]!;
    if (current !== 92) {
      output[written++] = current;
      continue;
    }
    i++;
    requireCondition(i < value.length, "TRUNCATED_COPY_ESCAPE");
    current = value[i]!;
    if (current >= 48 && current <= 55) {
      let number = current - 48;
      for (
        let j = 0;
        j < 2 &&
        i + 1 < value.length &&
        value[i + 1]! >= 48 &&
        value[i + 1]! <= 55;
        j++
      )
        number = number * 8 + value[++i]! - 48;
      requireCondition(number <= 255, "INVALID_COPY_OCTAL_ESCAPE");
      output[written++] = number;
    } else if (current === 120) {
      let hex = "";
      while (
        hex.length < 2 &&
        i + 1 < value.length &&
        /[0-9a-f]/i.test(String.fromCharCode(value[i + 1]!))
      )
        hex += String.fromCharCode(value[++i]!);
      output[written++] = hex.length ? Number.parseInt(hex, 16) : current;
    } else output[written++] = escapeBytes[current] ?? current;
  }
  return output.subarray(0, written);
}

async function* byteLines(input: Readable): AsyncGenerator<Buffer> {
  let remaining = Buffer.alloc(0);
  for await (const chunk of input) {
    const data = Buffer.concat([remaining, chunk as Buffer]);
    let start = 0;
    for (
      let newline = data.indexOf(10, start);
      newline !== -1;
      newline = data.indexOf(10, start)
    ) {
      yield data.subarray(start, newline);
      start = newline + 1;
    }
    remaining = data.subarray(start);
    requireCondition(
      remaining.length <= 64 * 1024 * 1024,
      "COPY_LINE_LIMIT_EXCEEDED"
    );
  }
  requireCondition(remaining.length === 0, "UNTERMINATED_DUMP_LINE");
}

function copyFields(line: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  for (
    let end = line.indexOf(9, start);
    end !== -1;
    end = line.indexOf(9, start)
  ) {
    result.push(line.subarray(start, end));
    start = end + 1;
  }
  result.push(line.subarray(start));
  return result;
}

function requiredField(
  row: Record<string, Buffer | null>,
  key: string
): Buffer {
  const value = row[key];
  requireCondition(value instanceof Buffer, "MISSING_REQUIRED_COPY_FIELD");
  return value;
}

function integerField(row: Record<string, Buffer | null>, key: string): bigint {
  const value = requiredField(row, key).toString("ascii");
  requireCondition(/^-?[0-9]+$/.test(value), "INVALID_INTEGER_FIELD");
  return BigInt(value);
}

async function main(): Promise<void> {
  const started = performance.now();
  process.umask(0o077);
  const args = parseArguments([
    "--dump",
    "--private-directory",
    "--pg-restore",
    "--expected-dump-sha256"
  ]);
  const dump = resolve(requiredArgument(args, "--dump"));
  const output = await privateDirectory(
    requiredArgument(args, "--private-directory")
  );
  const expected = requiredArgument(args, "--expected-dump-sha256");
  requireCondition(
    /^[0-9a-f]{64}$/.test(expected),
    "INVALID_EXPECTED_FINGERPRINT"
  );
  requireCondition(
    (await fingerprint(dump)) === expected,
    "DUMP_FINGERPRINT_MISMATCH"
  );
  // An exclusive creation prevents accidental reuse or truncation of a prior corpus.
  const databasePath = join(output, "corpus.sqlite");
  const exclusive = await open(databasePath, "wx", 0o600);
  await exclusive.close();
  const database = new DatabaseSync(databasePath);
  database.exec(
    "PRAGMA journal_mode=WAL; PRAGMA cache_size=-65536; PRAGMA temp_store=FILE;"
  );
  database.exec(
    "CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE manifest (version INTEGER, ordinal INTEGER, name BLOB, path BLOB, hash BLOB, size INTEGER); CREATE TABLE versions (id INTEGER PRIMARY KEY, metadata TEXT); CREATE TABLE apps (id TEXT PRIMARY KEY, owner_org TEXT);"
  );
  const insertManifest = database.prepare(
    "INSERT INTO manifest VALUES(?,?,?,?,?,?)"
  );
  const insertVersion = database.prepare("INSERT INTO versions VALUES(?,?)");
  const insertApp = database.prepare("INSERT INTO apps VALUES(?,?)");
  const state = database.prepare("INSERT OR REPLACE INTO state VALUES(?,?)");
  const stderr = await open(join(output, "pg-restore.stderr"), "wx", 0o600);
  const child = spawn(
    args.get("--pg-restore") ?? "pg_restore",
    ["--data-only", "--no-owner", "--no-privileges", "--file=-", dump],
    { stdio: ["ignore", "pipe", stderr.fd] }
  );
  // Attach immediately so a startup or early process failure is always observed.
  const exited = new Promise<number | null>((complete) => {
    child.once("error", () => complete(-1));
    child.once("close", (code) => complete(code));
  });
  const counts = { manifest: 0, app_versions: 0, apps: 0 };
  type Table = keyof typeof counts;
  let active: Table | null = null;
  let columns: string[] = [];
  const seen = new Set<Table>();
  let inTransaction = false;
  try {
    requireCondition(child.stdout, "RESTORE_STDOUT_UNAVAILABLE");
    database.exec("BEGIN");
    inTransaction = true;
    for await (const line of byteLines(child.stdout)) {
      if (active === null) {
        const match =
          /^COPY public\.(manifest|app_versions|apps) \(([^)]+)\) FROM stdin;$/.exec(
            line.toString("utf8")
          );
        if (match) {
          active = match[1] as Table;
          requireCondition(!seen.has(active), "DUPLICATE_COPY_TABLE");
          seen.add(active);
          columns = match[2]!
            .split(",")
            .map((column) => column.trim().replace(/^"|"$/g, ""));
        }
        continue;
      }
      if (line.equals(Buffer.from("\\."))) {
        active = null;
        continue;
      }
      const fields = copyFields(line);
      requireCondition(
        fields.length === columns.length,
        "COPY_COLUMN_COUNT_MISMATCH"
      );
      const row: Record<string, Buffer | null> = {};
      for (let i = 0; i < columns.length; i++)
        row[columns[i]!] = unescapeCopy(fields[i]!);
      counts[active]++;
      if (active === "manifest") {
        const name = requiredField(row, "file_name");
        const path = requiredField(row, "s3_path");
        const hash = requiredField(row, "file_hash");
        for (const field of [name, path, hash])
          requireCondition(
            Buffer.from(strictUtf8.decode(field)).equals(field),
            "NON_LOSSLESS_UTF8"
          );
        insertManifest.run(
          integerField(row, "app_version_id"),
          counts.manifest,
          name,
          path,
          hash,
          row.file_size === null ? null : integerField(row, "file_size")
        );
      } else if (active === "app_versions") {
        const metadata: Record<string, string | null> = {};
        for (const key of [
          "name",
          "app_id",
          "owner_org",
          "session_key",
          "created_at",
          "deleted"
        ])
          metadata[key] = row[key] == null ? null : strictUtf8.decode(row[key]);
        insertVersion.run(integerField(row, "id"), JSON.stringify(metadata));
      } else {
        insertApp.run(
          strictUtf8.decode(requiredField(row, "app_id")),
          row.owner_org == null ? null : strictUtf8.decode(row.owner_org)
        );
      }
      if ((counts.manifest + counts.app_versions + counts.apps) % 10000 === 0) {
        state.run("manifest_rows", String(counts.manifest));
        database.exec("COMMIT; BEGIN");
      }
      if (active === "manifest" && counts.manifest % 500000 === 0)
        console.log(
          JSON.stringify({
            stage: "ingest",
            rows: counts.manifest,
            seconds: Math.round((performance.now() - started) / 1000)
          })
        );
    }
    requireCondition((await exited) === 0, "PG_RESTORE_FAILED");
    requireCondition(
      active === null && seen.size === 3,
      "INCOMPLETE_COPY_STREAM"
    );
    database.exec("CREATE INDEX by_version ON manifest(version, ordinal)");
    state.run("manifest_rows", String(counts.manifest));
    state.run("complete", "true");
    database.exec("COMMIT");
    inTransaction = false;
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // Detect a dump replaced or modified while pg_restore was reading it.
    requireCondition(
      (await fingerprint(dump)) === expected,
      "DUMP_CHANGED_DURING_INGEST"
    );
    const report = {
      stage: "ingest",
      status: "complete",
      counts,
      dump_sha256: expected,
      dump_bytes: (await stat(dump)).size,
      seconds: Math.round((performance.now() - started) / 1000),
      node: process.version
    };
    await atomicJson(join(output, "ingest.json"), report);
    console.log(
      JSON.stringify({ stage: "ingest", status: "complete", counts })
    );
  } finally {
    if (inTransaction) database.exec("ROLLBACK");
    database.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    await stderr.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "failed",
      code: safeErrorCode(error, "CORPUS_INGEST_FAILED"),
      detail:
        "Source values suppressed. Private output is incomplete; use a fresh private directory after resolving the failure."
    })
  );
  process.exitCode = 1;
});
