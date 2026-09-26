import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import * as interruption from "../bench/interruption.mjs";
import { withDeadline, portAvailable } from "../bench/lifecycle.mjs";

describe("benchmark interruption cleanup", () => {
  it("waits for an owned real child on SIGTERM without touching another listener", async () => {
    const unrelated = createServer();
    await new Promise((resolve) => unrelated.listen(0, "127.0.0.1", resolve));
    const unrelatedPort = unrelated.address().port;
    const moduleUrl = new URL("../bench/interruption.mjs", import.meta.url)
      .href;
    const lifecycleUrl = new URL("../bench/lifecycle.mjs", import.meta.url)
      .href;
    const script = `
      import { spawn } from "node:child_process";
      import { installSignalCleanup } from ${JSON.stringify(moduleUrl)};
      import { withDeadline, portAvailable } from ${JSON.stringify(lifecycleUrl)};
      let child;
      let childClosed;
      let port;
      installSignalCleanup(async () => {
        if (!child) return;
        child.kill("SIGTERM");
        await withDeadline(1500, () => childClosed, "Owned child close");
        if (port) {
          await withDeadline(1500, async signal => {
            while (!signal.aborted && !(await portAvailable(port))) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          }, "Owned child port release");
        }
      });
      child = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      childClosed = new Promise(resolve => child.once("close", resolve));
      child.stdout.once("data", data => {
        port = Number(String(data).trim());
        console.log(JSON.stringify({ pid: child.pid, port }));
      });
    `;
    const phase = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const closed = new Promise((resolve) =>
      phase.once("close", (code) => resolve(code))
    );
    let diagnostics = "";
    phase.stderr.on("data", (data) => {
      diagnostics = (diagnostics + data).slice(-16_384);
    });
    let owned;
    let cleaned = false;
    let phaseExitCode;
    try {
      owned = await withDeadline(
        3_000,
        () =>
          new Promise((resolve, reject) => {
            let output = "";
            phase.stdout.on("data", (data) => {
              output += data;
              if (output.includes("\n"))
                resolve(JSON.parse(output.split("\n")[0]));
            });
            phase.once("error", reject);
          }),
        "Fixture startup"
      );
      phase.kill("SIGTERM");
      phaseExitCode = await withDeadline(
        3_000,
        () => closed,
        "Fixture cleanup"
      );
      expect(phaseExitCode, diagnostics).toBe(143);
      expect(await portAvailable(owned.port)).toBe(true);
      expect(await portAvailable(unrelatedPort)).toBe(false);
      cleaned = true;
    } finally {
      if (!cleaned) {
        // Allow the installed handler to release its child even when startup
        // failed before the parent received the child's PID. Force only after
        // the bounded graceful attempt, never as the first cleanup action.
        phase.kill("SIGTERM");
        try {
          phaseExitCode = await withDeadline(
            3_000,
            () => closed,
            "Fixture graceful cleanup"
          );
        } catch {
          phase.kill("SIGKILL");
          await withDeadline(1_000, () => closed, "Fixture forced cleanup");
        }
        if (phaseExitCode !== 143 && owned?.pid) {
          try {
            // The synthetic fixture is a single known child, not a process tree.
            process.kill(owned.pid, "SIGTERM");
          } catch (error) {
            expect(error).toHaveProperty("code", "ESRCH");
          }
        }
      }
      await new Promise((resolve) => unrelated.close(resolve));
    }
  });

  it("waits for cleanup before exiting on SIGTERM and handles repeated signals once", async () => {
    expect(interruption.installSignalCleanup).toBeTypeOf("function");
    const signals = new EventEmitter();
    const exit = vi.fn();
    let finish;
    const cleanup = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const hooks = interruption.installSignalCleanup(cleanup, {
      signals,
      exit,
      timeoutMs: 100
    });
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    finish();
    await hooks.stop();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
    hooks.dispose();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("bounds a stalled cleanup and reports failure without successful exit", async () => {
    expect(interruption.installSignalCleanup).toBeTypeOf("function");
    const signals = new EventEmitter();
    const exit = vi.fn();
    const reportError = vi.fn();
    const hooks = interruption.installSignalCleanup(
      () => new Promise(() => {}),
      { signals, exit, reportError, timeoutMs: 20 }
    );
    signals.emit("SIGINT");
    await expect(hooks.stop()).rejects.toThrow("Signal cleanup timed out");
    await Promise.resolve();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining("Signal cleanup timed out")
      })
    );
    hooks.dispose();
  });

  it("observes background rejection immediately and aborts a pending foreground request", async () => {
    expect(interruption.observeBackground).toBeTypeOf("function");
    let fail;
    const task = new Promise((_resolve, reject) => {
      fail = reject;
    });
    const observed = interruption.observeBackground(task);
    let requestSignal;
    const result = observed.race((signal) => {
      requestSignal = signal;
      return new Promise(() => {});
    });
    const assertion = expect(result).rejects.toThrow("CDP failed");
    fail(new Error("CDP failed"));
    await assertion;
    expect(requestSignal.aborted).toBe(true);
    await expect(observed.completion).rejects.toThrow("CDP failed");
  });

  it("retains an early background failure until a request attaches", async () => {
    expect(interruption.observeBackground).toBeTypeOf("function");
    const observed = interruption.observeBackground(
      Promise.reject(new Error("early failure"))
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(observed.race(async () => "success")).rejects.toThrow(
      "early failure"
    );
  });

  it("does not block successful foreground requests after background completion", async () => {
    expect(interruption.observeBackground).toBeTypeOf("function");
    const observed = interruption.observeBackground(Promise.resolve());
    await observed.completion;
    await expect(observed.race(async () => "success")).resolves.toBe("success");
  });
});
