/** Local-only full-corpus verification. Never print source rows or identifiers. */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData
} from "node:worker_threads";
import { packManifest, unpackManifest } from "../dist/index.js";
import type { ManifestContext, ManifestEntry } from "../dist/index.js";
import {
  atomicJson,
  fingerprint,
  parseArguments,
  privateDirectory,
  requireCondition,
  requiredArgument,
  safeErrorCode,
  validateIngestMetadata
} from "./corpus-common.ts";

interface Totals {
  versions: number;
  nonemptyVersions: number;
  emptyVersions: number;
  entries: number;
  payloadBytes: number;
  inputFieldBytes: number;
  fileSizeBytes: string;
  maxEntries: number;
  sourceChain: string;
  decodedChain: string;
}

interface Checkpoint extends Totals {
  runFingerprint: string;
  workerIndex: number;
  workers: number;
  lastVersion: string;
}

interface WorkerInput {
  sqlite: string;
  privatePath: string;
  workerIndex: number;
  workers: number;
  runFingerprint: string;
  resume: boolean;
}

interface SourceRow {
  name: Uint8Array;
  path: Uint8Array;
  hash: Uint8Array;
  size: bigint | null;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function emptyTotals(): Totals {
  return {
    versions: 0,
    nonemptyVersions: 0,
    emptyVersions: 0,
    entries: 0,
    payloadBytes: 0,
    inputFieldBytes: 0,
    fileSizeBytes: "0",
    maxEntries: 0,
    sourceChain: "0".repeat(64),
    decodedChain: "0".repeat(64)
  };
}

function readOnlyDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  database.exec(
    "PRAGMA query_only=ON; PRAGMA cache_size=-32768; PRAGMA temp_store=FILE;"
  );
  return database;
}

async function requireCheckpointedSqlite(path: string): Promise<void> {
  try {
    requireCondition(
      (await stat(`${path}-wal`)).size === 0,
      "SQLITE_HAS_UNCHECKPOINTED_WRITES"
    );
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
}

function textField(value: Uint8Array): string {
  requireCondition(value instanceof Uint8Array, "NON_BINARY_SOURCE_FIELD");
  const result = decoder.decode(value);
  requireCondition(Buffer.from(result).equals(value), "NON_LOSSLESS_UTF8");
  return result;
}

function contextFromMetadata(value: string): ManifestContext {
  const metadata = JSON.parse(value) as Record<string, unknown>;
  const context: Record<string, string> = {};
  for (const [source, target] of [
    ["owner_org", "org_id"],
    ["app_id", "app_id"],
    ["name", "version_name"],
    ["session_key", "session_key"]
  ] as const) {
    const field = metadata[source];
    requireCondition(
      field === null || field === undefined || typeof field === "string",
      "INVALID_SOURCE_CONTEXT"
    );
    if (typeof field === "string") context[target] = field;
  }
  return context;
}

function addTuple(
  hash: ReturnType<typeof createHash>,
  fields: readonly Uint8Array[],
  size: bigint
): void {
  for (const field of fields) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(field.byteLength));
    hash.update(length).update(field);
  }
  const encodedSize = Buffer.alloc(8);
  encodedSize.writeBigUInt64BE(size);
  hash.update(encodedSize);
}

function chain(previous: string, digest: string): string {
  return createHash("sha256").update(previous).update(digest).digest("hex");
}

async function runWorker(input: WorkerInput): Promise<Totals> {
  const database = readOnlyDatabase(input.sqlite);
  const checkpointPath = join(
    input.privatePath,
    `checkpoint-${input.workerIndex}.json`
  );
  let checkpoint: Checkpoint = {
    ...emptyTotals(),
    runFingerprint: input.runFingerprint,
    workerIndex: input.workerIndex,
    workers: input.workers,
    lastVersion: "-1"
  };
  if (input.resume) {
    try {
      const previous = JSON.parse(
        await readFile(checkpointPath, "utf8")
      ) as Checkpoint;
      requireCondition(
        previous.runFingerprint === input.runFingerprint &&
          previous.workers === input.workers &&
          previous.workerIndex === input.workerIndex,
        "CHECKPOINT_FINGERPRINT_MISMATCH"
      );
      requireCondition(
        previous.sourceChain === previous.decodedChain,
        "CHECKPOINT_DIGEST_MISMATCH"
      );
      checkpoint = previous;
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  const versions = database.prepare(
    "SELECT id, metadata FROM versions WHERE id>? AND id % ?=? ORDER BY id"
  );
  versions.setReadBigInts(true);
  const rowsQuery = database.prepare(
    "SELECT name,path,hash,size FROM manifest WHERE version=? ORDER BY ordinal"
  );
  rowsQuery.setReadBigInts(true);
  let activeVersion: string | undefined;
  let lastProgressAt = performance.now();
  try {
    for (const item of versions.iterate(
      BigInt(checkpoint.lastVersion),
      input.workers,
      input.workerIndex
    )) {
      const id = item.id as bigint;
      activeVersion = id.toString();
      const rows = rowsQuery.all(id) as unknown as SourceRow[];
      const entries: ManifestEntry[] = rows.map((row) => {
        requireCondition(
          row.size !== null && row.size >= 0n,
          "UNSUPPORTED_SOURCE_SIZE"
        );
        return {
          file_name: textField(row.name),
          s3_path: textField(row.path),
          file_hash: textField(row.hash),
          file_size: row.size
        };
      });
      // Modern ECMAScript stable sort preserves COPY ordinal for duplicate names.
      const sorted = rows
        .slice()
        .sort((a, b) => Buffer.compare(a.name, b.name));
      const packed = packManifest(entries, {
        context: contextFromMetadata(item.metadata as string)
      });
      const decoded = unpackManifest(packed);
      requireCondition(
        decoded.length === rows.length && packed.entry_count === rows.length,
        "ENTRY_COUNT_MISMATCH"
      );
      requireCondition(
        Buffer.from(packed.payload_hash).equals(
          createHash("sha256").update(packed.manifest).digest()
        ),
        "PAYLOAD_HASH_MISMATCH"
      );
      const sourceHash = createHash("sha256");
      const decodedHash = createHash("sha256");
      let versionSize = 0n;
      for (let i = 0; i < sorted.length; i++) {
        const source = sorted[i]!;
        const actual = decoded[i]!;
        const actualFields = [
          Buffer.from(actual.file_name),
          Buffer.from(actual.s3_path),
          Buffer.from(actual.file_hash)
        ];
        requireCondition(
          Buffer.from(source.name).equals(actualFields[0]!) &&
            Buffer.from(source.path).equals(actualFields[1]!) &&
            Buffer.from(source.hash).equals(actualFields[2]!) &&
            BigInt(actual.file_size) === source.size,
          "EXACT_TUPLE_MISMATCH"
        );
        const sourceSize = source.size!;
        addTuple(
          sourceHash,
          [source.name, source.path, source.hash],
          sourceSize
        );
        addTuple(decodedHash, actualFields, BigInt(actual.file_size));
        versionSize += sourceSize;
        checkpoint.inputFieldBytes +=
          source.name.byteLength +
          source.path.byteLength +
          source.hash.byteLength;
      }
      requireCondition(
        BigInt(packed.total_file_size) === versionSize,
        "FILE_SIZE_SUM_MISMATCH"
      );
      checkpoint.sourceChain = chain(
        checkpoint.sourceChain,
        sourceHash.digest("hex")
      );
      checkpoint.decodedChain = chain(
        checkpoint.decodedChain,
        decodedHash.digest("hex")
      );
      requireCondition(
        checkpoint.sourceChain === checkpoint.decodedChain,
        "TUPLE_DIGEST_MISMATCH"
      );
      checkpoint.versions++;
      if (rows.length === 0) checkpoint.emptyVersions++;
      else checkpoint.nonemptyVersions++;
      checkpoint.entries += rows.length;
      checkpoint.payloadBytes += packed.manifest.byteLength;
      checkpoint.fileSizeBytes = (
        BigInt(checkpoint.fileSizeBytes) + versionSize
      ).toString();
      checkpoint.maxEntries = Math.max(checkpoint.maxEntries, rows.length);
      checkpoint.lastVersion = id.toString();
      if (checkpoint.versions % 100 === 0) {
        await atomicJson(checkpointPath, checkpoint);
      }
      if (performance.now() - lastProgressAt >= 5000) {
        lastProgressAt = performance.now();
        parentPort?.postMessage({
          type: "progress",
          worker: input.workerIndex,
          versions: checkpoint.versions,
          entries: checkpoint.entries
        });
      }
    }
    await atomicJson(checkpointPath, checkpoint);
    return checkpoint;
  } catch (error) {
    await atomicJson(
      join(input.privatePath, `failure-${input.workerIndex}.json`),
      {
        runFingerprint: input.runFingerprint,
        workerIndex: input.workerIndex,
        version: activeVersion,
        code: safeErrorCode(error, "WORKER_VERIFICATION_FAILED")
      }
    );
    throw error;
  } finally {
    database.close();
  }
}

async function libraryFingerprint(): Promise<string> {
  const directory = fileURLToPath(new URL("../dist/", import.meta.url));
  const hash = createHash("sha256");
  for (const name of (await readdir(directory))
    .filter((name) => name.endsWith(".js"))
    .sort()) {
    hash.update(name).update(await readFile(join(directory, name)));
  }
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const started = performance.now();
  const args = parseArguments([
    "--sqlite",
    "--ingest-metadata",
    "--dump",
    "--expected-dump-sha256",
    "--private-directory",
    "--workers",
    "--resume",
    "--report"
  ]);
  const sqlite = resolve(requiredArgument(args, "--sqlite"));
  const dump = resolve(requiredArgument(args, "--dump"));
  const privatePath = await privateDirectory(
    requiredArgument(args, "--private-directory")
  );
  const workers = Number(args.get("--workers") ?? "2");
  requireCondition(
    Number.isInteger(workers) && workers >= 1 && workers <= 8,
    "INVALID_WORKER_COUNT"
  );
  requireCondition(
    !args.has("--resume") || ["true", "false"].includes(args.get("--resume")!),
    "INVALID_RESUME_OPTION"
  );
  console.log(JSON.stringify({ stage: "fingerprint", status: "running" }));
  const metadata = await validateIngestMetadata(
    JSON.parse(
      await readFile(requiredArgument(args, "--ingest-metadata"), "utf8")
    ),
    dump,
    requiredArgument(args, "--expected-dump-sha256")
  );
  await requireCheckpointedSqlite(sqlite);
  const sqliteStat = await stat(sqlite);
  const [sqliteSha256, librarySha256] = await Promise.all([
    fingerprint(sqlite),
    libraryFingerprint()
  ]);
  const runFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        dump: metadata.dump_sha256,
        sqlite: sqliteSha256,
        library: librarySha256,
        verifier: await fingerprint(fileURLToPath(import.meta.url)),
        common: await fingerprint(
          fileURLToPath(new URL("./corpus-common.ts", import.meta.url))
        ),
        node: process.version,
        workers
      })
    )
    .digest("hex");
  const database = readOnlyDatabase(sqlite);
  let sourceCounts: {
    entries: number;
    nonemptyVersions: number;
    allVersions: number;
    apps: number;
  };
  try {
    requireCondition(
      database.prepare("SELECT value FROM state WHERE key='complete'").get()
        ?.value === "true",
      "INCOMPLETE_SQLITE_IMPORT"
    );
    requireCondition(
      Number(
        database
          .prepare("SELECT value FROM state WHERE key='manifest_rows'")
          .get()?.value
      ) === metadata.counts.manifest,
      "IMPORT_CHECKPOINT_MISMATCH"
    );
    const counts = database
      .prepare(
        "SELECT count(*) AS entries, count(DISTINCT version) AS nonemptyVersions, count(DISTINCT ordinal) AS ordinals, min(ordinal) AS firstOrdinal, max(ordinal) AS lastOrdinal FROM manifest"
      )
      .get()!;
    const allVersions = database
      .prepare("SELECT count(*) AS count FROM versions")
      .get()!.count as number;
    const apps = database.prepare("SELECT count(*) AS count FROM apps").get()!
      .count as number;
    const orphans = database
      .prepare(
        "SELECT count(*) AS count FROM (SELECT DISTINCT version FROM manifest) m LEFT JOIN versions v ON v.id=m.version WHERE v.id IS NULL"
      )
      .get()!.count;
    requireCondition(
      counts.entries === metadata.counts.manifest &&
        allVersions === metadata.counts.app_versions &&
        apps === metadata.counts.apps,
      "SOURCE_COUNT_MISMATCH"
    );
    requireCondition(
      counts.ordinals === counts.entries &&
        (counts.entries === 0 ||
          (counts.firstOrdinal === 1 && counts.lastOrdinal === counts.entries)),
      "COPY_ORDINAL_COVERAGE_MISMATCH"
    );
    requireCondition(orphans === 0, "MANIFEST_VERSION_METADATA_MISSING");
    sourceCounts = {
      entries: counts.entries as number,
      nonemptyVersions: counts.nonemptyVersions as number,
      allVersions,
      apps
    };
  } finally {
    database.close();
  }
  console.log(JSON.stringify({ stage: "coverage", ...sourceCounts }));
  const empty = packManifest([]);
  requireCondition(
    unpackManifest(empty).length === 0 &&
      empty.entry_count === 0 &&
      BigInt(empty.total_file_size) === 0n,
    "EMPTY_MANIFEST_MISMATCH"
  );
  const active: Worker[] = [];
  let results: Totals[];
  try {
    results = await Promise.all(
      Array.from(
        { length: workers },
        (_, workerIndex) =>
          new Promise<Totals>((complete, reject) => {
            const worker = new Worker(new URL(import.meta.url), {
              workerData: {
                sqlite,
                privatePath,
                workerIndex,
                workers,
                runFingerprint,
                resume: args.get("--resume") === "true"
              } satisfies WorkerInput
            });
            active.push(worker);
            let finished = false;
            worker.on(
              "message",
              (message: { type: string; result?: Totals; code?: string }) => {
                if (message.type === "complete" && message.result) {
                  finished = true;
                  complete(message.result);
                } else if (message.type === "progress")
                  console.log(JSON.stringify(message));
                else if (message.type === "failure")
                  reject(
                    new Error(message.code ?? "WORKER_VERIFICATION_FAILED")
                  );
              }
            );
            worker.on("error", () =>
              reject(new Error("WORKER_RUNTIME_FAILED"))
            );
            worker.on("exit", (code) => {
              if (code !== 0 || !finished)
                reject(new Error("WORKER_INCOMPLETE"));
            });
          })
      )
    );
  } finally {
    await Promise.all(active.map((worker) => worker.terminate()));
  }
  const totals = results.reduce(
    (sum, value) => ({
      versions: sum.versions + value.versions,
      nonemptyVersions: sum.nonemptyVersions + value.nonemptyVersions,
      emptyVersions: sum.emptyVersions + value.emptyVersions,
      entries: sum.entries + value.entries,
      payloadBytes: sum.payloadBytes + value.payloadBytes,
      inputFieldBytes: sum.inputFieldBytes + value.inputFieldBytes,
      fileSizeBytes: (
        BigInt(sum.fileSizeBytes) + BigInt(value.fileSizeBytes)
      ).toString(),
      maxEntries: Math.max(sum.maxEntries, value.maxEntries),
      sourceChain: "",
      decodedChain: ""
    }),
    emptyTotals()
  );
  requireCondition(
    totals.entries === sourceCounts.entries &&
      totals.versions === sourceCounts.allVersions &&
      totals.nonemptyVersions === sourceCounts.nonemptyVersions &&
      totals.emptyVersions ===
        sourceCounts.allVersions - sourceCounts.nonemptyVersions,
    "FULL_CORPUS_COVERAGE_MISMATCH"
  );
  const finalStat = await stat(sqlite);
  await requireCheckpointedSqlite(sqlite);
  requireCondition(
    finalStat.size === sqliteStat.size &&
      finalStat.mtimeMs === sqliteStat.mtimeMs &&
      (await fingerprint(sqlite)) === sqliteSha256,
    "SQLITE_CHANGED_DURING_VERIFICATION"
  );
  requireCondition(
    librarySha256 === (await libraryFingerprint()),
    "LIBRARY_CHANGED_DURING_VERIFICATION"
  );
  const report = {
    status: "passed",
    verification:
      "every four-field tuple; stable UTF-8 byte sort; duplicate multiplicity preserved",
    sourceFingerprintVerified: true,
    sourceCopyOrdinalsComplete: true,
    manifestEntries: totals.entries,
    nonemptyVersionsVerified: totals.nonemptyVersions,
    emptyVersionsVerified: totals.emptyVersions,
    versionsWithoutManifest: totals.emptyVersions,
    allVersionRecordsAccountedFor: sourceCounts.allVersions,
    apps: sourceCounts.apps,
    emptyManifestRoundtripVerified: true,
    payloadHashesVerified: true,
    fileSizeSumsVerified: true,
    totalFileSizeBytes: totals.fileSizeBytes,
    totalPayloadBytes: totals.payloadBytes,
    sourceTextFieldBytes: totals.inputFieldBytes,
    maximumEntriesInOneManifest: totals.maxEntries,
    workers,
    librarySha256,
    node: process.version,
    resumed: args.get("--resume") === "true",
    seconds: Math.round((performance.now() - started) / 1000),
    options: "defaults with source version context; no increased limits"
  };
  await atomicJson(join(privatePath, "verification-private.json"), {
    report,
    runFingerprint,
    sourceDumpSha256: metadata.dump_sha256,
    sourceSqliteSha256: sqliteSha256,
    results
  });
  if (args.has("--report"))
    await atomicJson(resolve(args.get("--report")!), report);
  console.log(JSON.stringify(report));
}

if (isMainThread) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: "failed",
        code: safeErrorCode(error, "CORPUS_VERIFICATION_FAILED"),
        detail:
          "No source values printed. Check arguments, import provenance, runtime, and private checkpoints; failed rows are never skipped."
      })
    );
    process.exitCode = 1;
  });
} else {
  runWorker(workerData as WorkerInput).then(
    (result) => parentPort!.postMessage({ type: "complete", result }),
    (error: unknown) => {
      parentPort!.postMessage({
        type: "failure",
        code: safeErrorCode(error, "WORKER_VERIFICATION_FAILED")
      });
      process.exitCode = 1;
    }
  );
}
