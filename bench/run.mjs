import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  fetchJson,
  openInspector,
  portAvailable,
  stopChildGroup,
  trackChild,
  withDeadline
} from "./lifecycle.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.BENCH_PORT ?? 8787);
const inspectorPort = Number(process.env.BENCH_INSPECTOR_PORT ?? 9231);
if (
  ![port, inspectorPort].every(
    (value) => Number.isInteger(value) && value > 0 && value <= 65_535
  ) ||
  port === inspectorPort
)
  throw new Error(
    "Benchmark ports must be distinct integers between 1 and 65535"
  );
const base = `http://127.0.0.1:${port}`;
const MIB = 1024 * 1024;
const guardBytes = 96 * MIB;
const hardLimitBytes = 128_000_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = process.argv[2] ?? "suite";
if (!["suite", "quick", "matrix", "memory", "stress", "probe"].includes(mode))
  throw new Error("Use suite, quick, matrix, memory, stress, or probe");
const destination = resolve(
  process.argv[3] ?? join(root, "bench/results", `${mode}.json`)
);
const temp = await mkdtemp(join(tmpdir(), "manifest-packing-bench-"));
const workerBundle = join(temp, "worker.js");
await exec(
  "bun",
  ["build", "bench/worker.ts", "--target=node", `--outfile=${workerBundle}`],
  { cwd: root }
);

class Inspector {
  nextId = 1;
  pending = new Map();
  listeners = [];
  scripts = [];
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else {
        if (message.method === "Debugger.scriptParsed")
          this.scripts.push(message.params);
        for (const listener of this.listeners) listener(message);
      }
    });
  }
  call(method, params = {}, signal) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`CDP timed out: ${method}`));
      }, 20_000);
      const abort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        reject(new Error(`CDP aborted: ${method}`));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Inspector closed"));
    }
    this.pending.clear();
    this.socket.terminate();
  }
}

async function request(path, options = {}) {
  const { response, value } = await fetchJson(`${base}${path}`, options);
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(value)}`);
  return value;
}

async function start() {
  const deadline = performance.now() + 30_000;
  const ports = [port, inspectorPort];
  if (
    !(
      await withDeadline(
        30_000,
        () => Promise.all(ports.map(portAvailable)),
        "Port preflight"
      )
    ).every(Boolean)
  )
    throw new Error("Benchmark service or inspector port is already occupied");
  let output = "";
  const child = spawn(
    process.execPath,
    [
      join(root, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      workerBundle,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--inspector-ip",
      "127.0.0.1",
      "--persist-to",
      join(temp, "state"),
      "--log-level",
      "warn",
      "--show-interactive-dev-session=false"
    ],
    {
      cwd: root,
      detached: true,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(temp, "wrangler.log"),
        CI: "true",
        BROWSER: "none"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const lifecycle = trackChild(child);
  let inspector;
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    return await withDeadline(
      Math.max(1, Math.ceil(deadline - performance.now())),
      async (signal) => {
        const checkChild = () => {
          if (lifecycle.error) throw lifecycle.error;
          if (
            lifecycle.closed ||
            child.exitCode !== null ||
            child.signalCode !== null
          )
            throw new Error(`Wrangler exited before startup completed`);
        };
        while (!signal.aborted) {
          checkChild();
          try {
            await request("/health", { timeoutMs: 1_000, signal });
            checkChild();
            break;
          } catch {
            checkChild();
            if (signal.aborted) throw new Error("Wrangler startup aborted");
            await pause(200);
          }
        }
        const { value: targets } = await fetchJson(
          `http://127.0.0.1:${inspectorPort}/json/list`,
          { timeoutMs: 5_000, signal }
        );
        const target =
          targets.find(
            (entry) =>
              entry.webSocketDebuggerUrl &&
              /manifest-packing/.test(entry.title ?? entry.id ?? "")
          ) ?? targets.find((entry) => entry.webSocketDebuggerUrl);
        if (!target) throw new Error("No workerd inspector target");
        const socket = await openInspector(target.webSocketDebuggerUrl, signal);
        inspector = new Inspector(socket);
        await inspector.call("Runtime.enable", {}, signal);
        checkChild();
        return {
          child,
          lifecycle,
          inspector,
          target: { id: target.id, title: target.title, url: target.url },
          output: () => output
        };
      },
      "Wrangler startup"
    );
  } catch (error) {
    try {
      await stop({ child, lifecycle, inspector });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${error.message}; ${cleanupError.message}`
      );
    }
    throw error;
  }
}

async function stop(server) {
  server.inspector?.close();
  await stopChildGroup(server.lifecycle, [port, inspectorPort]);
}

async function hostMetrics(parentPid) {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss=,comm="]);
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return match
        ? {
            pid: Number(match[1]),
            parent: Number(match[2]),
            rssBytes: Number(match[3]) * 1024,
            command: match[4]
          }
        : undefined;
    })
    .filter(Boolean);
  const ids = new Set([parentPid]);
  for (let pass = 0; pass < 8; pass++)
    for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid);
  return rows
    .filter((row) => ids.has(row.pid))
    .map(({ pid, rssBytes, command }) => ({
      pid,
      rssBytes,
      kind: /workerd/.test(command)
        ? "workerd-process"
        : "wrangler-or-helper-process"
    }));
}

async function observe(server, action) {
  const samples = [];
  const rssSamples = [];
  let phase = "starting";
  let running = true;
  let failure;
  const started = performance.now();
  const listener = (message) => {
    if (message.method !== "Runtime.consoleAPICalled") return;
    for (const arg of message.params.args ?? []) {
      try {
        const value = JSON.parse(arg.value);
        if (value.checkpoint) phase = value.checkpoint;
      } catch {
        /* Other logs. */
      }
    }
  };
  server.inspector.listeners.push(listener);
  const collect = async () => {
    while (running) {
      try {
        const memory = await server.inspector.call("Runtime.getHeapUsage");
        const sample = {
          elapsedMs: performance.now() - started,
          phase,
          ...memory
        };
        // Never substitute zero for a field absent in this workerd CDP version.
        if (
          typeof memory.backingStorageSize === "number" &&
          typeof memory.embedderHeapUsedSize === "number"
        )
          sample.accountedBytes =
            memory.usedSize +
            memory.backingStorageSize +
            memory.embedderHeapUsedSize;
        samples.push(sample);
        if (sample.accountedBytes > guardBytes) {
          failure = `Observed isolate accounting crossed diagnostic 96 MiB guard: ${sample.accountedBytes}`;
        }
        if (sample.accountedBytes > hardLimitBytes) {
          process.exitCode = 1;
          failure = `Observed isolate accounting crossed hard 128 MB limit: ${sample.accountedBytes}`;
          running = false;
        }
      } catch (error) {
        failure = error.message;
        running = false;
      }
      await pause(8);
    }
  };
  const collectRss = async () => {
    while (running) {
      rssSamples.push({
        elapsedMs: performance.now() - started,
        processes: await hostMetrics(server.child.pid)
      });
      await pause(80);
    }
  };
  const collecting = collect();
  const collectingRss = collectRss();
  let value;
  try {
    value = await action();
  } finally {
    running = false;
    await Promise.all([collecting, collectingRss]);
    server.inspector.listeners = server.inspector.listeners.filter(
      (entry) => entry !== listener
    );
  }
  const fields = [
    "usedSize",
    "totalSize",
    "backingStorageSize",
    "embedderHeapUsedSize",
    "accountedBytes"
  ];
  const peaks = Object.fromEntries(
    fields.map((field) => [
      field,
      samples.some((sample) => typeof sample[field] === "number")
        ? Math.max(...samples.map((sample) => sample[field] ?? 0))
        : null
    ])
  );
  return {
    value,
    sampleIntervalRequestedMs: 8,
    peaks,
    guardBytes,
    hardLimitBytes,
    hardLimitExceeded: peaks.accountedBytes > hardLimitBytes,
    guardFailure: failure ?? null,
    samples,
    rssSamples
  };
}

// Stop the isolate at two allocation checkpoints. This is intentionally a
// separate workload: inspector pauses must never contaminate timing samples.
async function pausedDecode(server) {
  const inspector = server.inspector;
  await inspector.call("Debugger.enable");
  const script = inspector.scripts.find((entry) =>
    entry.url.endsWith("/worker.js")
  );
  if (!script) throw new Error("Worker bundle absent from debugger scripts");
  const { scriptSource } = await inspector.call("Debugger.getScriptSource", {
    scriptId: script.scriptId
  });
  const lines = scriptSource.split("\n");
  const decoderStart = lines.findIndex((line) =>
    line.startsWith("function unpackManifest(")
  );
  const decoderEnd = lines.findIndex(
    (line, index) => index > decoderStart && line === "}"
  );
  if (decoderStart < 0 || decoderEnd < 0)
    throw new Error("Cannot locate decoder body");
  const breakpoints = new Map();
  const locations = [];
  for (const [label, statement] of [
    ["decoded-blocks-alive", "const names = new Reader(nameData);"],
    ["decoded-entries-alive", "return rows;"]
  ]) {
    const matches = lines.flatMap((line, index) =>
      index > decoderStart && index < decoderEnd && line.trim() === statement
        ? [index]
        : []
    );
    if (matches.length !== 1)
      throw new Error(`Ambiguous allocation checkpoint: ${label}`);
    const { breakpointId, actualLocation } = await inspector.call(
      "Debugger.setBreakpoint",
      {
        location: { scriptId: script.scriptId, lineNumber: matches[0] }
      }
    );
    breakpoints.set(breakpointId, label);
    locations.push({
      label,
      breakpointId,
      requestedLine: matches[0],
      actualLine: actualLocation?.lineNumber
    });
  }
  const samples = [];
  const tasks = [];
  const listener = (message) => {
    if (message.method !== "Debugger.paused") return;
    tasks.push(
      (async () => {
        try {
          const memory = await inspector.call("Runtime.getHeapUsage");
          const sample = {
            lineNumber: message.params.callFrames[0]?.location.lineNumber,
            checkpoint: locations.find(
              (location) =>
                location.actualLine ===
                message.params.callFrames[0]?.location.lineNumber
            )?.label,
            ...memory,
            processes: await hostMetrics(server.child.pid)
          };
          if (
            typeof memory.backingStorageSize === "number" &&
            typeof memory.embedderHeapUsedSize === "number"
          )
            sample.accountedBytes =
              memory.usedSize +
              memory.backingStorageSize +
              memory.embedderHeapUsedSize;
          samples.push(sample);
        } finally {
          await inspector.call("Debugger.resume");
        }
      })()
    );
  };
  inspector.listeners.push(listener);
  let value;
  try {
    value = await request("/memory?repeats=1");
    await Promise.all(tasks);
    if (
      samples.length !== 2 ||
      new Set(samples.map((sample) => sample.checkpoint)).size !== 2 ||
      !value.correct
    )
      throw new Error("Decode allocation checkpoints incomplete");
  } finally {
    inspector.listeners = inspector.listeners.filter(
      (entry) => entry !== listener
    );
    for (const breakpointId of breakpoints.keys())
      await inspector.call("Debugger.removeBreakpoint", { breakpointId });
    await inspector.call("Debugger.disable");
  }
  const hardLimitExceeded = samples.some(
    (sample) => sample.accountedBytes > hardLimitBytes
  );
  if (hardLimitExceeded) process.exitCode = 1;
  return {
    value,
    samples,
    locations,
    guardBytes,
    hardLimitBytes,
    hardLimitExceeded,
    guardFailure: samples.some((sample) => sample.accountedBytes > guardBytes)
      ? "Allocation checkpoint crossed diagnostic 96 MiB guard"
      : null
  };
}

const packageInfo = JSON.parse(
  await readFile(join(root, "node_modules/wrangler/package.json"), "utf8")
);
const workerdInfo = JSON.parse(
  await readFile(join(root, "node_modules/workerd/package.json"), "utf8")
);
const report = {
  generatedAt: new Date().toISOString(),
  mode,
  environment: {
    node: process.version,
    wrangler: packageInfo.version,
    workerd: workerdInfo.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    workerBundleSha256: createHash("sha256")
      .update(await readFile(workerBundle))
      .digest("hex"),
    runnerSourceSha256: createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .update(await readFile(join(root, "bench/lifecycle.mjs")))
      .digest("hex"),
    compatibilityDate: "2026-09-25"
  },
  methodology: {
    localOnly: true,
    lifecycleDescription:
      "Port preflight; startup deadline 30 seconds; shutdown confirms child close, process-group exit, and both ports released, with 5-second graceful and 5-second forced-stop budgets.",
    diagnosticLimitBytes: guardBytes,
    hardLimitBytes,
    productionMemoryGuarantee: false,
    memoryDescription:
      "CDP Runtime.getHeapUsage, independent fields and same-sample sum when all available. Native codec allocations may be absent. Host workerd RSS is process-wide and includes other isolates/runtime. No forced GC during workloads.",
    coldDescription:
      "Fresh Wrangler/workerd per named case. Fixture is encoded first; firstDecodeMs measures first unpack in fresh isolate, excluding process startup and I/O."
  },
  timings: [],
  memory: [],
  guards: []
};
let active;
try {
  if (mode === "probe") {
    active = await start();
    await active.inspector.call("Debugger.enable");
    report.probe = await request("/runtime-probe");
    report.probe.heap = await active.inspector.call("Runtime.getHeapUsage");
    console.log(JSON.stringify(report.probe));
  }
  if (mode === "suite" || mode === "quick") {
    for (const name of mode === "quick"
      ? ["median", "maximum"]
      : [
          "small",
          "median",
          "p95",
          "maximum",
          "rsa-v2",
          "rsa-v3",
          "utf8",
          "long-paths"
        ]) {
      process.stdout.write(`Timing ${name}\n`);
      active = await start();
      const prepared = await request(`/prepare?case=${name}`);
      const measurement = await observe(active, () =>
        request(
          `/time?batch=${name === "small" ? 100 : name === "median" ? 10 : 2}&samples=9`
        )
      );
      const result = measurement.value;
      if (!result.warmDecodeMs.samples.some((sample) => sample > 0))
        throw new Error("Runtime clock did not advance; timings invalid");
      const { value: _value, ...memoryDuringTiming } = measurement;
      report.timings.push({ ...prepared, ...result, memoryDuringTiming });
      if (measurement.hardLimitExceeded)
        throw new Error(
          "Timing workload exceeded hard 128 MB accounting limit"
        );
      await stop(active);
      active = undefined;
    }
  }
  if (mode === "matrix") {
    const modulePath = join(temp, "encoder.mjs");
    await exec(
      "bun",
      ["build", "bench/encoder.ts", "--target=node", `--outfile=${modulePath}`],
      { cwd: root }
    );
    const { encodeFixture } = await import(pathToFileURL(modulePath).href);
    active = await start();
    for (const transform of ["raw", "prefix"])
      for (const codec of ["none", "brotli", "zstd"])
        for (const sizes of ["absolute", "delta"]) {
          process.stdout.write(`Matrix ${transform}/${codec}/${sizes}\n`);
          const { prepared, packet } = encodeFixture(
            "maximum",
            codec,
            transform,
            sizes
          );
          await request("/import?case=maximum", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(packet)
          });
          const measurement = await observe(active, () =>
            request("/time?batch=2&samples=9")
          );
          const { value: result, ...memoryDuringTiming } = measurement;
          report.timings.push({
            ...prepared,
            ...result,
            memoryDuringTiming,
            firstDecodeIsCold: false
          });
          if (measurement.hardLimitExceeded)
            throw new Error(
              "Timing matrix exceeded hard 128 MB accounting limit"
            );
        }
    await stop(active);
    active = undefined;
  }
  if (
    mode === "suite" ||
    mode === "quick" ||
    mode === "memory" ||
    mode === "stress"
  ) {
    for (const name of mode === "quick"
      ? ["maximum"]
      : ["maximum", "rsa-v3", "long-paths"]) {
      process.stdout.write(`Memory ${name}\n`);
      active = await start();
      const preparation = await observe(active, () =>
        request(`/prepare?case=${name}`)
      );
      const allocationCheckpoints = await pausedDecode(active);
      async function freshPhase(action) {
        await stop(active);
        active = await start();
        const phasePreparation = await observe(active, () =>
          request(`/prepare?case=${name}`)
        );
        const result = await observe(active, action);
        return { ...result, preparation: phasePreparation };
      }
      const unguardedCopies = mode === "stress" ? 8 : 2;
      const retained = await freshPhase(() =>
        request(`/memory?repeats=${unguardedCopies}`)
      );
      const concurrent = await freshPhase(() =>
        Promise.all(
          Array.from({ length: unguardedCopies }, () => request("/hold"))
        )
      );
      const guardedConcurrent = await freshPhase(() =>
        Promise.all(
          Array.from({ length: 8 }, async () => {
            const { response, value } = await fetchJson(
              `${base}/hold?guarded=1`
            );
            return { status: response.status, ...value };
          })
        )
      );
      const repeated = await freshPhase(async () => {
        let correct = true;
        for (let index = 0; index < 20; index++) {
          const value = await request("/hold?guarded=1&holdMs=1");
          correct &&= value.correct;
        }
        return { requests: 20, correct };
      });
      report.memory.push({
        name,
        unguardedCopies,
        preparation,
        allocationCheckpoints,
        retained,
        concurrent,
        guardedConcurrent,
        repeated
      });
      report.guards.push({ name, ...(await request("/guards")) });
      if (!report.adversarial)
        report.adversarial = await observe(active, () =>
          request("/adversarial")
        );
      if (
        !report.guards[report.guards.length - 1].passed ||
        !report.adversarial.value.passed
      )
        throw new Error("Worker guard or adversarial validation failed");
      if (
        [retained, concurrent, guardedConcurrent, repeated].some(
          (phase) => phase.hardLimitExceeded
        )
      )
        throw new Error(
          "Memory workload exceeded hard 128 MB accounting limit"
        );
      if (
        !retained.value.correct ||
        !concurrent.value.every((entry) => entry.correct) ||
        !repeated.value.correct ||
        guardedConcurrent.value.filter(
          (entry) => entry.status === 200 && entry.correct
        ).length !== 1 ||
        guardedConcurrent.value.filter((entry) => entry.status === 429)
          .length !== 7
      )
        throw new Error("Worker retention or admission validation failed");
      await stop(active);
      active = undefined;
    }
  }
} catch (error) {
  // Raw Wrangler logs stay in the private temporary directory, not public reports.
  report.error = {
    message: error.message
      .split("\n")[0]
      .replaceAll(root, "<repository>")
      .replaceAll(temp, "<temporary-directory>")
  };
  process.exitCode = 1;
} finally {
  if (active) {
    try {
      await stop(active);
    } catch (error) {
      report.error ??= {
        message: error.message
          .split("\n")[0]
          .replaceAll(root, "<repository>")
          .replaceAll(temp, "<temporary-directory>")
      };
      process.exitCode = 1;
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${destination}`);
  if (report.error) console.error(report.error.message);
}
