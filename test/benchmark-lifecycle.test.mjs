import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchJson,
  openInspector,
  portAvailable,
  stopChildGroup,
  trackChild,
  withDeadline
} from "../bench/lifecycle.mjs";

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function stalledServer() {
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      })
  );
  return server.address().port;
}

function childState(pid = 12345) {
  const child = Object.assign(new EventEmitter(), { pid });
  return trackChild(child);
}

function missingGroup() {
  return Object.assign(new Error("No such process"), { code: "ESRCH" });
}

describe("benchmark deadlines", () => {
  it("bounds the whole startup operation and aborts its pending work", async () => {
    let signal;
    await expect(
      withDeadline(
        20,
        (value) => {
          signal = value;
          return new Promise(() => {});
        },
        "Startup"
      )
    ).rejects.toThrow("Startup timed out");
    expect(signal.aborted).toBe(true);
  });

  it("times out a stalled JSON body after response headers arrive", async () => {
    const port = await stalledServer();
    await expect(
      fetchJson(`http://127.0.0.1:${port}`, { timeoutMs: 100 })
    ).rejects.toThrow(/timed out/);
  });

  it("aborts a stalled inspector WebSocket handshake at the startup deadline", async () => {
    const port = await stalledServer();
    await expect(
      withDeadline(
        50,
        (signal) => openInspector(`ws://127.0.0.1:${port}`, signal),
        "Startup"
      )
    ).rejects.toThrow(/timed out/);
  });

  it("detects occupied ports and releases its successful bind probes", async () => {
    const port = await stalledServer();
    expect(await portAvailable(port)).toBe(false);
    // Port zero asks the OS for a temporary unused port, released by the probe.
    expect(await portAvailable(0)).toBe(true);
  });
});

describe("benchmark child-group shutdown", () => {
  it("waits for child close and delayed port release without signaling a vanished group again", async () => {
    const state = childState();
    let alive = true;
    let probes = 0;
    const kill = vi.fn((_pid, signal) => {
      if (!alive) throw missingGroup();
      if (signal === "SIGTERM") {
        alive = false;
        state.child.emit("close");
      }
    });
    await stopChildGroup(state, [8787, 9231], {
      graceMs: 100,
      forceMs: 100,
      pollMs: 1,
      kill,
      available: async () => ++probes >= 5
    });
    expect(probes).toBeGreaterThanOrEqual(6);
    expect(kill.mock.calls).toEqual([
      [-12345, "SIGTERM"],
      [-12345, 0]
    ]);
  });

  it("forces only the original child group when descendants outlive a closed leader", async () => {
    const state = childState();
    let alive = true;
    const kill = vi.fn((_pid, signal) => {
      if (!alive) throw missingGroup();
      if (signal === "SIGTERM") state.child.emit("close");
      if (signal === "SIGKILL") alive = false;
    });
    await stopChildGroup(state, [8787, 9231], {
      graceMs: 10,
      forceMs: 100,
      pollMs: 1,
      kill,
      available: async () => !alive
    });
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [-12345, "SIGTERM"],
      [-12345, "SIGKILL"]
    ]);
  });

  it("fails within its cleanup budget if another listener occupies a port and never signals that listener", async () => {
    const state = childState();
    const kill = vi.fn(() => {
      state.child.emit("close");
      throw missingGroup();
    });
    await expect(
      stopChildGroup(state, [8787, 9231], {
        graceMs: 10,
        forceMs: 10,
        pollMs: 1,
        kill,
        available: async () => false
      })
    ).rejects.toThrow("shutdown deadline");
    expect(kill.mock.calls).toEqual([[-12345, "SIGTERM"]]);
  });

  it("makes concurrent cleanup idempotent and confirms closure even if ports are already free", async () => {
    const state = childState();
    const kill = vi.fn(() => {
      throw missingGroup();
    });
    const options = {
      graceMs: 100,
      forceMs: 100,
      pollMs: 1,
      kill,
      available: async () => true
    };
    const first = stopChildGroup(state, [8787, 9231], options);
    expect(stopChildGroup(state, [8787, 9231], options)).toBe(first);
    let finished = false;
    first.then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finished).toBe(false);
    state.child.emit("close");
    await first;
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("handles a failed spawn with no PID without signaling a process", async () => {
    const state = childState(null);
    state.child.emit("error", new Error("spawn failed"));
    state.child.emit("close");
    const kill = vi.fn();
    await stopChildGroup(state, [], { kill });
    expect(state.error.message).toBe("spawn failed");
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not hide permission errors when signaling its child group", async () => {
    const state = childState();
    await expect(
      stopChildGroup(state, [], {
        kill: () => {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        }
      })
    ).rejects.toThrow("denied");
  });
});
