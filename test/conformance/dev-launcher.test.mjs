import assert from "node:assert/strict";
import { test } from "node:test";

import { terminateProcessTree } from "../../tools/process-tree.mjs";

test("Windows teardown terminates the complete descendant process tree", () => {
  const calls = [];
  const child = { killed: false, pid: 4321 };

  terminateProcessTree(child, "SIGTERM", {
    platform: "win32",
    runTaskkill(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [{
    command: "taskkill",
    args: ["/pid", "4321", "/T", "/F"],
    options: { stdio: "ignore", windowsHide: true },
  }]);
});

test("Unix teardown preserves process-group signalling", () => {
  const calls = [];
  const child = { killed: false, pid: 4321 };

  terminateProcessTree(child, "SIGINT", {
    platform: "linux",
    killProcess(pid, signal) { calls.push({ pid, signal }); },
  });

  assert.deepEqual(calls, [{ pid: -4321, signal: "SIGINT" }]);
});

test("teardown ignores already-stopped and pid-less children", () => {
  let calls = 0;
  const dependencies = {
    platform: "win32",
    runTaskkill() { calls += 1; return { status: 0 }; },
  };

  terminateProcessTree({ killed: true, pid: 4321 }, "SIGTERM", dependencies);
  terminateProcessTree({ killed: false }, "SIGTERM", dependencies);

  assert.equal(calls, 0);
});

test("Windows teardown falls back to direct child signalling when taskkill fails", () => {
  const signals = [];
  const child = {
    killed: false,
    pid: 4321,
    kill(signal) { signals.push(signal); },
  };

  terminateProcessTree(child, "SIGTERM", {
    platform: "win32",
    runTaskkill() { return { status: 1 }; },
  });

  assert.deepEqual(signals, ["SIGTERM"]);
});
