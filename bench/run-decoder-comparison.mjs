import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  fetchJson,
  openInspector,
  portAvailable,
  stopChildGroup,
  trackChild,
  withDeadline
} from "./lifecycle.mjs";
import { installSignalCleanup } from "./interruption.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineRef =
  process.env.BASELINE_REF ?? "b8b099401f78ea8c52c648fbd250c82af7d682ac";
const rounds = Number(process.env.COMPARE_ROUNDS ?? 3);
const warmSamples = Number(process.env.COMPARE_SAMPLES ?? 9);
const profileIterations = Number(process.env.COMPARE_PROFILE_ITERATIONS ?? 12);
const port = Number(process.env.COMPARE_PORT ?? 8789);
const inspectorPort = Number(process.env.COMPARE_INSPECTOR_PORT ?? 9233);
if (
  ![rounds, warmSamples, profileIterations].every(
    (value) => Number.isInteger(value) && value > 0 && value <= 30
  )
)
  throw new Error("Benchmark repetitions must be 1..30");
if (
  ![port, inspectorPort].every(
    (value) => Number.isInteger(value) && value > 0 && value <= 65535
  ) ||
  port === inspectorPort
)
  throw new Error("Invalid distinct benchmark ports");
const mode = process.argv[2] ?? "compare";
if (!["compare", "profile"].includes(mode))
  throw new Error("Use compare or profile");
const destination = resolve(
  process.argv[3] ?? join(root, "bench/results", `decoder-${mode}.json`)
);
const temp = await mkdtemp(join(tmpdir(), "manifest-decoder-comparison-"));
const base = `http://127.0.0.1:${port}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function snapshot(variant) {
  const directory = join(temp, variant);
  const source = (await readdir(join(root, "src")))
    .filter((name) => name.endsWith(".ts"))
    .sort();
  const paths = [
    ...source.map((name) => `src/${name}`),
    "fixtures/synthetic.ts",
    "bench/decoder-comparison-worker.ts",
    "bench/decoder-comparison-fixtures.ts"
  ];
  const hashes = {};
  for (const path of paths) {
    // The new harness is identical for both implementations; only library source differs.
    let bytes =
      variant === "baseline" && path.startsWith("src/")
        ? Buffer.from(
            (
              await exec("git", ["show", `${baselineRef}:${path}`], {
                cwd: root,
                maxBuffer: 4 * 1024 * 1024,
                timeout: 30_000
              })
            ).stdout
          )
        : await readFile(join(root, path));
    hashes[path] = digest(bytes);
    if (mode === "profile" && path === "src/codec.ts") {
      let source = bytes.toString();
      const substitutions = [
        [
          "): DecodedManifestEntry[] {",
          "): DecodedManifestEntry[] {\n  const profileStart = performance.now();"
        ],
        [
          "  const nameData = decompress(namesBlock);",
          "  const profileBeforeBlocks = performance.now();\n  const nameData = decompress(namesBlock);"
        ],
        [
          "  const tailData = decompress(tailsBlock);",
          "  const tailData = decompress(tailsBlock);\n  const profileAfterBlocks = performance.now();"
        ],
        [
          "  return rows;",
          "  (globalThis as typeof globalThis & { __manifestProfile?: Record<string, number> }).__manifestProfile = { preambleMs: profileBeforeBlocks-profileStart, decompressMs: profileAfterBlocks-profileBeforeBlocks, entriesMs: performance.now()-profileAfterBlocks };\n  return rows;"
        ]
      ];
      for (const [before, after] of substitutions) {
        if (source.split(before).length !== 2)
          throw new Error("Profile instrumentation anchor changed");
        source = source.replace(before, after);
      }
      bytes = Buffer.from(source);
    }
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), bytes);
  }
  const bundle = join(directory, "worker.js");
  await exec(
    "bun",
    [
      "build",
      join(directory, "bench/decoder-comparison-worker.ts"),
      "--target=node",
      `--outfile=${bundle}`
    ],
    { cwd: root, timeout: 30_000 }
  );
  return {
    directory,
    bundle,
    hashes,
    bundleSha256: digest(await readFile(bundle))
  };
}

class Inspector {
  next = 1;
  pending = new Map();
  constructor(socket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new Error(`CDP error: ${message.error.message}`));
      else pending.resolve(message.result);
    });
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Inspector closed"));
    }
    this.pending.clear();
    this.socket.terminate();
  }
}

async function request(path, options) {
  const { response, value } = await fetchJson(base + path, options);
  if (!response.ok)
    throw new Error(`Benchmark request failed: ${response.status}`);
  return value;
}
async function start(bundle) {
  if (
    !(
      await withDeadline(
        30000,
        () => Promise.all([port, inspectorPort].map(portAvailable)),
        "Port preflight"
      )
    ).every(Boolean)
  )
    throw new Error("Benchmark ports occupied");
  let stopOwnedRuntime = async () => {};
  const interruption = installSignalCleanup(() => stopOwnedRuntime());
  const child = spawn(
    process.execPath,
    [
      join(root, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      bundle,
      "--config",
      join(root, "wrangler.jsonc"),
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-ip",
      "127.0.0.1",
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      join(temp, "state"),
      "--log-level",
      "warn",
      "--show-interactive-dev-session=false"
    ],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(temp, "wrangler.log"),
        CI: "true",
        BROWSER: "none"
      }
    }
  );
  // Drain logs but never publish runtime paths or environment details.
  child.stdout.resume();
  child.stderr.resume();
  const lifecycle = trackChild(child);
  let inspector;
  stopOwnedRuntime = async () => {
    inspector?.close();
    await stopChildGroup(lifecycle, [port, inspectorPort]);
  };
  const stop = async () => {
    try {
      await interruption.stop();
    } finally {
      interruption.dispose();
    }
  };
  try {
    await withDeadline(
      30000,
      async (signal) => {
        for (;;) {
          if (lifecycle.error || lifecycle.closed)
            throw new Error("Wrangler failed to start");
          try {
            await request("/health", { timeoutMs: 1000, signal });
            break;
          } catch {
            if (signal.aborted) throw new Error("Startup aborted");
            await pause(100);
          }
        }
        const { value: targets } = await fetchJson(
          `http://127.0.0.1:${inspectorPort}/json/list`,
          { timeoutMs: 5000, signal }
        );
        const target =
          targets.find(
            (entry) =>
              /manifest-packing/.test(entry.title ?? "") &&
              entry.webSocketDebuggerUrl
          ) ?? targets.find((entry) => entry.webSocketDebuggerUrl);
        if (!target) throw new Error("No inspector target");
        inspector = new Inspector(
          await openInspector(target.webSocketDebuggerUrl, signal)
        );
        await inspector.call("Runtime.enable");
      },
      "Worker startup"
    );
    return { inspector, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted.at(-1)
  };
}
function profileSummary(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id);
  const self = new Map();
  const allSelf = new Map();
  const inclusive = new Map();
  let decodeUs = 0;
  let totalUs = 0;
  for (let i = 0; i < (profile.samples ?? []).length; i++) {
    const id = profile.samples[i];
    const us = profile.timeDeltas?.[i] ?? 0;
    totalUs += us;
    const sampledName = nodes.get(id).callFrame.functionName || "(anonymous)";
    allSelf.set(sampledName, (allSelf.get(sampledName) ?? 0) + us);
    let cursor = id;
    let isDecode = false;
    const stackNames = new Set();
    while (cursor) {
      const name = nodes.get(cursor)?.callFrame.functionName;
      if (name) stackNames.add(name);
      if (name === "unpackManifest") isDecode = true;
      cursor = parents.get(cursor);
    }
    for (const name of stackNames)
      inclusive.set(name, (inclusive.get(name) ?? 0) + us);
    if (!isDecode) continue;
    decodeUs += us;
    const frame = nodes.get(id).callFrame;
    const key = frame.functionName || "(anonymous)";
    self.set(key, (self.get(key) ?? 0) + us);
  }
  return {
    totalProfileUs: totalUs,
    unpackStackUs: decodeUs,
    allTopSelf: [...allSelf.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([functionName, sampleUs]) => ({ functionName, sampleUs })),
    topInclusive: [...inclusive.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([functionName, sampleUs]) => ({ functionName, sampleUs })),
    topSelf: [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([functionName, sampleUs]) => ({
        functionName,
        sampleUs,
        percentOfUnpackStack: (sampleUs / decodeUs) * 100
      }))
  };
}

const snapshots = {
  baseline: await snapshot("baseline"),
  candidate: await snapshot("candidate")
};
const fixtureDirectory = join(temp, "fixtures");
// Baseline encoder generates identical, Node-produced packets for both decoders.
const fixtureModule = join(temp, "fixtures.mjs");
await exec(
  "bun",
  [
    "build",
    join(snapshots.baseline.directory, "bench/decoder-comparison-fixtures.ts"),
    "--target=node",
    `--outfile=${fixtureModule}`
  ],
  { cwd: root, timeout: 30_000 }
);
await exec(process.execPath, [fixtureModule, fixtureDirectory], {
  cwd: root,
  timeout: 120000
});
const fixtures = JSON.parse(
  await readFile(join(fixtureDirectory, "metadata.json"), "utf8")
);
const selected = process.env.COMPARE_CASES
  ? fixtures.filter((value) =>
      process.env.COMPARE_CASES.split(",").includes(value.name)
    )
  : fixtures;
if (selected.length === 0) throw new Error("No selected scenarios");
const results = [];
allMeasurements: for (
  let round = 0;
  round < (mode === "profile" ? 1 : rounds);
  round++
) {
  for (const fixture of selected) {
    const order =
      round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
    for (const variant of order) {
      console.log(
        JSON.stringify({ phase: mode, round, scenario: fixture.name, variant })
      );
      let runtime;
      try {
        runtime = await start(snapshots[variant].bundle);
        const bytes = await readFile(
          join(fixtureDirectory, `${fixture.name}.bin`)
        );
        await request(
          `/prepare?${new URLSearchParams({ count: String(fixture.count), total: fixture.total, hash: fixture.hash })}`,
          { method: "POST", body: bytes }
        );
        const first = await request("/decode?verify=1");
        if (
          first.fingerprint !== fixture.fingerprint ||
          first.entries !== fixture.count
        )
          throw new Error("Exact tuple fingerprint mismatch");
        for (let warm = 0; warm < 3; warm++) await request("/decode");
        const sampleMs = [];
        const stageSamples = [];
        let profile;
        let memory;
        if (mode === "profile") {
          await runtime.inspector.call("Profiler.enable");
          await runtime.inspector.call("Profiler.setSamplingInterval", {
            interval: 250
          });
          await runtime.inspector.call("Profiler.start");
          for (let i = 0; i < profileIterations; i++) {
            const value = await request("/decode");
            sampleMs.push(value.elapsedMs);
            stageSamples.push(value.stages);
          }
          profile = profileSummary(
            (await runtime.inspector.call("Profiler.stop")).profile
          );
          memory = await runtime.inspector.call("Runtime.getHeapUsage");
        } else {
          for (let i = 0; i < warmSamples; i++) {
            sampleMs.push((await request("/decode")).elapsedMs);
            await pause(10);
          }
        }
        results.push({
          round,
          scenario: fixture.name,
          variant,
          packetBytes: fixture.packetBytes,
          blocks: fixture.blocks,
          firstDecodeMs: first.elapsedMs,
          warmMs: summary(sampleMs),
          correctness: true,
          profile,
          stageSamples,
          memory,
          singleShotHash: (await request("/health")).singleShotHash
        });
      } catch {
        results.push({ round, scenario: fixture.name, variant, failed: true });
        process.exitCode = 1;
      } finally {
        try {
          await runtime?.stop();
        } catch {
          results.push({
            round,
            scenario: fixture.name,
            variant,
            failed: true,
            phase: "shutdown"
          });
          process.exitCode = 1;
        }
      }
      if (process.exitCode === 1) break allMeasurements;
    }
  }
}
const report = {
  passed: !results.some((result) => result.failed),
  generatedAt: new Date().toISOString(),
  mode,
  baselineRef,
  runtime: {
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    wrangler: JSON.parse(
      await readFile(join(root, "node_modules/wrangler/package.json"))
    ).version,
    workerd: JSON.parse(
      await readFile(join(root, "node_modules/workerd/package.json"))
    ).version
  },
  method: {
    rounds: mode === "profile" ? 1 : rounds,
    warmSamples,
    warmups: 3,
    profileIterations,
    profileIntervalUs: 250,
    freshIsolatePerScenarioVariantRound: true,
    order: "AB/BA alternates each round",
    syntheticOnly: true,
    exactTupleFingerprintAfterFirstTimedDecode: true,
    inputPacketsFromBaselineNodeEncoder: true,
    forcedGc: false,
    singleDecodePerRequest: true,
    timingExcludesFixtureAndVerification: true,
    profileOnlyCoarseStageInstrumentation: mode === "profile"
  },
  source: Object.fromEntries(
    Object.entries(snapshots).map(([name, value]) => [
      name,
      { hashes: value.hashes, bundleSha256: value.bundleSha256 }
    ])
  ),
  results
};
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    complete: true,
    passed: report.passed,
    mode,
    measurements: results.length
  })
);
