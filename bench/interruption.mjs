import { withDeadline } from "./lifecycle.mjs";

/** Cleanup owns its original child groups; this helper never discovers port owners. */
export function installSignalCleanup(
  cleanup,
  {
    signals = process,
    exit = (code) => process.exit(code),
    reportError = (error) =>
      console.error("Benchmark signal cleanup failed:", error),
    timeoutMs = 12_000
  } = {}
) {
  let stopping;
  let interrupted = false;
  const stop = () =>
    (stopping ??= withDeadline(timeoutMs, cleanup, "Signal cleanup"));
  const interrupt = (code) => {
    if (interrupted) return;
    interrupted = true;
    void stop().then(
      () => exit(code),
      (error) => {
        reportError(error);
        exit(1);
      }
    );
  };
  const terminate = () => interrupt(143);
  const cancel = () => interrupt(130);
  signals.on("SIGTERM", terminate);
  signals.on("SIGINT", cancel);
  return {
    stop,
    dispose() {
      signals.off("SIGTERM", terminate);
      signals.off("SIGINT", cancel);
    }
  };
}

/** Attach rejection handlers immediately, even before the first foreground operation. */
export function observeBackground(task) {
  const completion = Promise.resolve(task);
  let rejectFailure;
  const failure = new Promise((_resolve, reject) => {
    rejectFailure = reject;
  });
  void completion.catch(rejectFailure);
  void failure.catch(() => {});
  return {
    completion,
    async race(action) {
      const controller = new AbortController();
      try {
        return await Promise.race([failure, action(controller.signal)]);
      } finally {
        controller.abort();
      }
    }
  };
}
