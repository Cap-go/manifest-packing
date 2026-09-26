import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  fetchJson,
  openInspector,
  portAvailable,
  stopChildGroup,
  trackChild,
  withDeadline
} from "./lifecycle.mjs";
import { installSignalCleanup, observeBackground } from "./interruption.mjs";

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const selectedCodec = process.argv[2];
const selectedMethod = process.argv[3];
const hashMode =
  selectedCodec === "hash" ||
  selectedCodec === "hash-scratch" ||
  ["64", "344", "512"].includes(selectedCodec);
if (
  !selectedCodec ||
  selectedCodec === "hash" ||
  selectedCodec === "hash-scratch"
) {
  const phases = [];
  for (const codec of hashMode ? ["64", "344", "512"] : ["brotli", "zstd"]) {
    for (const method of selectedCodec === "hash-scratch"
      ? ["createHash-reuseBuffer"]
      : hashMode
        ? ["createHash", "hash", "webcrypto-sequential", "webcrypto-batch32"]
        : ["sync", "async-sequential", "async-all"]) {
      // Keep ownership here; killing a separate phase coordinator with an
      // outer timeout can otherwise strand its detached Wrangler.
      await runPhase(codec, method);
      phases.push(
        JSON.parse(
          await readFile(
            join(
              root,
              `bench/results/async-decompression-${codec}-${method}.json`
            ),
            "utf8"
          )
        )
      );
    }
  }
  await writeFile(
    join(
      root,
      `bench/results/async-${selectedCodec === "hash-scratch" ? "hash-scratch" : hashMode ? "hash" : "decompression"}.json`
    ),
    `${JSON.stringify({ phases }, null, 2)}\n`
  );
  console.log(
    JSON.stringify(
      phases.map((phase) => ({
        summary: phase.summary,
        memory: phase.memory,
        capabilities: phase.capabilities
      })),
      null,
      2
    )
  );
  process.exit(0);
}
async function runPhase(selectedCodec, selectedMethod) {
  const hashMode = ["64", "344", "512"].includes(selectedCodec);
  if (
    !(hashMode ? ["64", "344", "512"] : ["brotli", "zstd"]).includes(
      selectedCodec
    ) ||
    !(
      hashMode
        ? [
            "createHash",
            "createHash-reuseBuffer",
            "hash",
            "webcrypto-sequential",
            "webcrypto-batch32"
          ]
        : ["sync", "async-sequential", "async-all"]
    ).includes(selectedMethod)
  )
    throw new Error("Invalid probe phase");
  const temp = await mkdtemp(join(tmpdir(), "manifest-async-probe-"));
  const port = 8797;
  const inspectorPort = 9247;
  const ports = [port, inspectorPort];
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const base = `http://127.0.0.1:${port}`;
  for (const part of hashMode ? ["worker"] : ["encode", "worker"])
    await exec(
      "bun",
      [
        "build",
        `bench/async-decompression-${part}.ts`,
        "--target=node",
        `--outfile=${join(temp, `${part}.mjs`)}`
      ],
      { cwd: root, timeout: 30_000 }
    );
  const { stdout: payload } = hashMode
    ? { stdout: "" }
    : await exec(process.execPath, [join(temp, "encode.mjs")], {
        maxBuffer: 12_000_000,
        timeout: 30_000
      });
  if (
    !(
      await withDeadline(
        30_000,
        () => Promise.all(ports.map(portAvailable)),
        "Port preflight"
      )
    ).every(Boolean)
  )
    throw new Error("Probe ports occupied");
  let stopOwnedRuntime = async () => {};
  const interruption = installSignalCleanup(() => stopOwnedRuntime());
  const child = spawn(
    process.execPath,
    [
      join(root, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      join(temp, "worker.mjs"),
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
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(temp, "wrangler.log"),
        CI: "true",
        BROWSER: "none"
      },
      stdio: "ignore"
    }
  );
  const lifecycle = trackChild(child);
  let socket;
  let nextId = 0;
  const pending = new Map();
  const call = (method) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("CDP deadline"));
      }, 5_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.send(JSON.stringify({ id, method }));
    });
  const samples = [];
  let monitorActive = false;
  let monitor;
  stopOwnedRuntime = async () => {
    monitorActive = false;
    socket?.terminate();
    for (const request of pending.values())
      request.reject(new Error("Inspector closed"));
    pending.clear();
    await stopChildGroup(lifecycle, ports);
  };
  try {
    await withDeadline(
      30_000,
      async (signal) => {
        while (!signal.aborted) {
          if (lifecycle.closed || lifecycle.error)
            throw new Error("Wrangler stopped during startup");
          try {
            await fetchJson(`${base}/health`, { timeoutMs: 1_000, signal });
            break;
          } catch {
            await pause(100);
          }
        }
        const { value: targets } = await fetchJson(
          `http://127.0.0.1:${inspectorPort}/json/list`,
          { timeoutMs: 5_000, signal }
        );
        const target =
          targets.find(
            (target) =>
              /manifest-packing/.test(target.title ?? "") &&
              target.webSocketDebuggerUrl
          ) ?? targets.find((target) => target.webSocketDebuggerUrl);
        if (!target) throw new Error("No workerd target");
        socket = await openInspector(target.webSocketDebuggerUrl, signal);
        socket.on("message", (raw) => {
          const message = JSON.parse(String(raw));
          if (!message.id) return;
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          if (message.error) request.reject(new Error("CDP failure"));
          else request.resolve(message.result);
        });
        await call("Runtime.enable");
      },
      "Probe startup"
    );
    const request = async (path, options = {}) => {
      const action = (signal) =>
        fetchJson(`${base}${path}`, {
          timeoutMs: 30_000,
          ...options,
          signal:
            options.signal && signal
              ? AbortSignal.any([options.signal, signal])
              : (signal ?? options.signal)
        });
      const { response, value } = monitor
        ? await monitor.race(action)
        : await action();
      if (!response.ok) throw new Error("Probe HTTP failure");
      return value;
    };
    const prepared = hashMode
      ? await request(`/prepare-hash?characters=${selectedCodec}`)
      : await request("/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload
        });
    const capabilities = hashMode ? undefined : await request("/capabilities");
    const baseline = await call("Runtime.getHeapUsage");
    monitorActive = true;
    monitor = observeBackground(
      (async () => {
        while (monitorActive) {
          samples.push(await call("Runtime.getHeapUsage"));
          await pause(5);
        }
      })()
    );
    const timings = [];
    const methods = [selectedMethod];
    for (let round = 0; round < (hashMode ? 6 : 15); round++) {
      for (const codec of [selectedCodec]) {
        for (let index = 0; index < methods.length; index++) {
          const method = methods[index];
          timings.push({
            round,
            codec,
            ...(await request(
              hashMode
                ? `/hash?method=${method}`
                : `/measure?codec=${codec}&method=${method}`
            ))
          });
        }
      }
    }
    monitorActive = false;
    await monitor.completion;
    monitor = undefined;
    const relevant = samples.filter((sample) =>
      [
        sample.usedSize,
        sample.backingStorageSize,
        sample.embedderHeapUsedSize
      ].every(Number.isFinite)
    );
    const maximumAccountedBytes = relevant.length
      ? Math.max(
          ...relevant.map(
            (sample) =>
              sample.usedSize +
              sample.backingStorageSize +
              sample.embedderHeapUsedSize
          )
        )
      : null;
    const summary = (hashMode ? [{ codec: selectedCodec }] : prepared.variants)
      .filter(({ codec }) => codec === selectedCodec)
      .flatMap(({ codec }) =>
        methods.map((method) => {
          const values = timings
            .filter(
              (sample) =>
                sample.codec === codec &&
                sample.method === method &&
                sample.round >= (hashMode ? 2 : 3)
            )
            .map((sample) => sample.elapsedMs)
            .sort((a, b) => a - b);
          return {
            codec,
            method,
            medianMs: values[Math.floor(values.length / 2)],
            p95Ms: values[Math.ceil(values.length * 0.95) - 1]
          };
        })
      );
    const report = {
      timestamp: new Date().toISOString(),
      runtime: {
        node: process.version,
        wrangler: JSON.parse(
          await readFile(
            join(root, "node_modules/wrangler/package.json"),
            "utf8"
          )
        ).version,
        workerd: JSON.parse(
          await readFile(
            join(root, "node_modules/workerd/package.json"),
            "utf8"
          )
        ).version
      },
      method: hashMode
        ? "Synthetic 10000 unique checksum strings. Fresh workerd per character length/method, 6 rounds first 2 warmup. Includes input TextEncoder and output lowercase hexadecimal conversion for WebCrypto, no more than 32 concurrent digests. Timings exclude fixture preparation and exact correctness comparisons. CDP sampled every 5 ms, no forced GC; native allocations may be absent."
        : "Synthetic 10000 RSA-v3 entries; same independently framed filename and metadata bytes compressed in Node. Fresh workerd per codec/method; 15 rounds, first 3 warmup; one decode pair per HTTP request. Timings exclude preparation, transport and SHA256 correctness checks. CDP sampled every 5 ms without forced GC; memory includes retained synthetic fixture; native allocations may be absent. Earlier combined 90-pair pilot exceeded 128 MB and was discarded; separate phases avoid accumulated pilot allocation history.",
      prepared,
      capabilities,
      summary,
      memory: { baseline, maximumAccountedBytes, sampleCount: samples.length },
      timings
    };
    await writeFile(
      join(
        root,
        `bench/results/async-decompression-${selectedCodec}-${selectedMethod}.json`
      ),
      `${JSON.stringify(report, null, 2)}\n`
    );
    console.log(
      JSON.stringify({ summary, capabilities, maximumAccountedBytes }, null, 2)
    );
    if (maximumAccountedBytes !== null && maximumAccountedBytes > 128_000_000)
      throw new Error("Sampled memory exceeded128MB; report preserved");
  } finally {
    try {
      await interruption.stop();
      if (monitor) await monitor.completion.catch(() => {});
    } finally {
      interruption.dispose();
    }
  }
}

await runPhase(selectedCodec, selectedMethod);
