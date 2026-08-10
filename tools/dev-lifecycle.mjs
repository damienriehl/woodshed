const EXIT_CODES = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);

export function signalExitCode(signal) {
  return EXIT_CODES.get(signal) ?? 1;
}

export function createTeardownController({
  children,
  terminate,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  exit = (code) => process.exit(code),
  reportFailure = (error) => console.error("Woodshed development launcher teardown failed:", error),
  graceMs = 5_000,
}) {
  let requestedSignal = null;
  let graceTimer = null;

  function terminateAll(signal) {
    for (const child of children) {
      try { terminate(child, signal); }
      catch (error) { reportFailure(error); }
    }
  }

  function forceExit() {
    terminateAll("SIGKILL");
    exit(signalExitCode(requestedSignal));
  }

  function startGraceTimer() {
    if (graceTimer !== null) return;
    graceTimer = setTimer(forceExit, graceMs);
    graceTimer?.unref?.();
  }

  return {
    get requestedSignal() { return requestedSignal; },
    get requestedExitCode() { return requestedSignal ? signalExitCode(requestedSignal) : null; },
    handleSignal(signal) {
      if (requestedSignal) {
        if (graceTimer !== null) clearTimer(graceTimer);
        forceExit();
        return;
      }

      requestedSignal = signal;
      terminateAll(signal);
      startGraceTimer();
    },
    stop(signal = "SIGTERM") {
      terminateAll(signal);
      startGraceTimer();
    },
    settled() {
      if (graceTimer !== null) clearTimer(graceTimer);
      graceTimer = null;
    },
  };
}
