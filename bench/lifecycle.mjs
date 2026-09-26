import { createServer } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { WebSocket } from "ws";

class DeadlineError extends Error {}

export async function withDeadline(timeoutMs, action, label) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new DeadlineError(`${label} timed out after ${timeoutMs} ms`));
          controller.abort();
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function fetchJson(
  url,
  { timeoutMs = 120_000, signal, ...options } = {}
) {
  return withDeadline(
    timeoutMs,
    async (deadlineSignal) => {
      const response = await fetch(url, {
        ...options,
        signal: signal
          ? AbortSignal.any([signal, deadlineSignal])
          : deadlineSignal
      });
      return { response, value: await response.json() };
    },
    "HTTP request"
  );
}

export function openInspector(url, signal) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Origin: "http://localhost" },
      handshakeTimeout: 5_000
    });
    const abort = () => socket.terminate();
    const cleanup = () => signal.removeEventListener("abort", abort);
    socket.once("open", () => {
      cleanup();
      resolve(socket);
    });
    socket.once("error", (error) => {
      cleanup();
      reject(new Error(`Inspector connection failed: ${error.message}`));
    });
    socket.once("close", () => {
      cleanup();
      reject(new Error("Inspector closed before connecting"));
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

export function trackChild(child) {
  const state = {
    child,
    closed: false,
    error: undefined,
    stopPromise: undefined
  };
  child.once("close", () => {
    state.closed = true;
  });
  child.once("error", (error) => {
    state.error = error;
  });
  return state;
}

export function stopChildGroup(
  state,
  ports,
  {
    graceMs = 5_000,
    forceMs = 5_000,
    pollMs = 50,
    available = portAvailable,
    kill = process.kill
  } = {}
) {
  if (state.stopPromise) return state.stopPromise;
  state.stopPromise = (async () => {
    const pid = state.child.pid;
    let groupGone = !Number.isSafeInteger(pid) || pid <= 1;
    const signalGroup = (signal) => {
      if (groupGone) return;
      try {
        kill(-pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        // Never signal this numeric group again after observing its disappearance.
        groupGone = true;
      }
    };
    const waitUntilStopped = async (timeoutMs) => {
      try {
        return await withDeadline(
          timeoutMs,
          async (signal) => {
            while (!signal.aborted) {
              signalGroup(0);
              const free = await Promise.all(ports.map(available));
              if (state.closed && groupGone && free.every(Boolean)) return true;
              await pause(pollMs, undefined, { signal });
            }
            return false;
          },
          "Child shutdown"
        );
      } catch (error) {
        if (error instanceof DeadlineError) return false;
        throw error;
      }
    };
    signalGroup("SIGTERM");
    if (await waitUntilStopped(graceMs)) return;
    signalGroup("SIGKILL");
    if (!(await waitUntilStopped(forceMs)))
      throw new Error(
        "Benchmark child group did not close and release its ports within the shutdown deadline"
      );
  })();
  return state.stopPromise;
}
