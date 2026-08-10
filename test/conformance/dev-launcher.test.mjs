import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createTeardownController, signalExitCode } from "../../tools/dev-lifecycle.mjs";
import { terminateProcessTree } from "../../tools/process-tree.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readPublishedPid(pidFile) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return Number(await readFile(pidFile, "utf8")); }
    catch { await delay(25); }
  }
  assert.fail("parent did not publish its descendant PID");
}

async function waitForExit(child, timeout = 1_000) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not exit`)), timeout);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function assertProcessGone(pid, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      assert.equal(error.code, "ESRCH");
      return;
    }
    await delay(25);
  }
  assert.fail(`process ${pid} is still running`);
}

const descendantParentScript = `
  const { spawn } = require("node:child_process");
  const { writeFileSync } = require("node:fs");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.argv[1], String(child.pid));
  setInterval(() => {}, 1000);
`;

test("launcher maps all handled terminal signals to conventional exit codes", () => {
  assert.equal(signalExitCode("SIGHUP"), 129);
  assert.equal(signalExitCode("SIGINT"), 130);
  assert.equal(signalExitCode("SIGTERM"), 143);
});

test("SIGHUP uses the normal teardown path and preserves hangup exit semantics", () => {
  const calls = [];
  const controller = createTeardownController({
    children: [{ pid: 1 }, { pid: 2 }],
    terminate(child, signal) { calls.push({ pid: child.pid, signal }); },
    setTimer() { return 11; },
    clearTimer() {},
    exit(code) { calls.push({ exit: code }); },
  });

  controller.handleSignal("SIGHUP");
  assert.deepEqual(calls, [
    { pid: 1, signal: "SIGHUP" },
    { pid: 2, signal: "SIGHUP" },
  ]);
  assert.equal(controller.requestedExitCode, 129);
});

test("a repeated terminal signal escalates immediately and exits", () => {
  const calls = [];
  const controller = createTeardownController({
    children: [{ pid: 1 }],
    terminate(child, signal) { calls.push({ pid: child.pid, signal }); },
    setTimer() { return 12; },
    clearTimer(timer) { calls.push({ cleared: timer }); },
    exit(code) { calls.push({ exit: code }); },
  });

  controller.handleSignal("SIGINT");
  controller.handleSignal("SIGINT");
  assert.deepEqual(calls, [
    { pid: 1, signal: "SIGINT" },
    { cleared: 12 },
    { pid: 1, signal: "SIGKILL" },
    { exit: 130 },
  ]);
});

test("first-signal grace expiry force-stops children and exits", () => {
  const calls = [];
  let expire;
  const controller = createTeardownController({
    children: [{ pid: 1 }],
    terminate(child, signal) { calls.push({ pid: child.pid, signal }); },
    setTimer(callback, delay) { expire = callback; calls.push({ delay }); return 13; },
    clearTimer() {},
    exit(code) { calls.push({ exit: code }); },
    graceMs: 250,
  });

  controller.handleSignal("SIGTERM");
  expire();
  assert.deepEqual(calls, [
    { pid: 1, signal: "SIGTERM" },
    { delay: 250 },
    { pid: 1, signal: "SIGKILL" },
    { exit: 143 },
  ]);
});

test("forced exit is not suppressed when one child teardown throws", () => {
  const calls = [];
  let expire;
  const controller = createTeardownController({
    children: [{ pid: 1 }, { pid: 2 }],
    terminate(child, signal) {
      calls.push({ pid: child.pid, signal });
      if (child.pid === 1 && signal === "SIGKILL") throw new Error("already gone");
    },
    reportFailure(error) { calls.push({ failure: error.message }); },
    setTimer(callback) { expire = callback; return 14; },
    clearTimer() {},
    exit(code) { calls.push({ exit: code }); },
  });

  controller.handleSignal("SIGTERM");
  expire();
  assert.deepEqual(calls.slice(-4), [
    { pid: 1, signal: "SIGKILL" },
    { failure: "already gone" },
    { pid: 2, signal: "SIGKILL" },
    { exit: 143 },
  ]);
});

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

test("Unix teardown terminates a real detached parent and descendant", { skip: process.platform === "win32", timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "woodshed-process-tree-"));
  const pidFile = join(directory, "descendant.pid");
  const parent = spawn(process.execPath, ["-e", descendantParentScript, pidFile], {
    detached: true,
    stdio: "ignore",
  });

  try {
    const descendantPid = await readPublishedPid(pidFile);

    terminateProcessTree(parent, "SIGTERM", { platform: process.platform });
    await waitForExit(parent);
    await assertProcessGone(descendantPid);
  } finally {
    try { process.kill(-parent.pid, "SIGKILL"); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows teardown terminates a real parent and Node descendant", { skip: process.platform !== "win32", timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "woodshed-windows-process-tree-"));
  const pidFile = join(directory, "descendant.pid");
  const parent = spawn(process.execPath, ["-e", descendantParentScript, pidFile], { stdio: "ignore" });

  try {
    const descendantPid = await readPublishedPid(pidFile);
    assert.equal(terminateProcessTree(parent, "SIGTERM"), true, "Windows tree termination reported incomplete cleanup");
    await waitForExit(parent, 2_000);
    await assertProcessGone(descendantPid, 2_000);
  } finally {
    try { parent.kill("SIGKILL"); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test("POSIX launcher handles SIGHUP with exit 129 and descendant cleanup", { skip: process.platform === "win32", timeout: 4_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "woodshed-sighup-launcher-"));
  const pidFile = join(directory, "descendant.pid");
  const lifecycleUrl = new URL("../../tools/dev-lifecycle.mjs", import.meta.url).href;
  const processTreeUrl = new URL("../../tools/process-tree.mjs", import.meta.url).href;
  const launcherScript = `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { createTeardownController, signalExitCode } from ${JSON.stringify(lifecycleUrl)};
    import { terminateProcessTree } from ${JSON.stringify(processTreeUrl)};
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    writeFileSync(process.argv[1], String(child.pid));
    const teardown = createTeardownController({ children: [child], terminate: terminateProcessTree, graceMs: 500 });
    process.on("SIGHUP", () => teardown.handleSignal("SIGHUP"));
    child.once("exit", () => {
      process.exitCode = signalExitCode(teardown.requestedSignal);
      teardown.settled();
    });
    setInterval(() => {}, 1000).unref();
  `;
  const launcher = spawn(process.execPath, ["--input-type=module", "-e", launcherScript, pidFile], { stdio: "ignore" });

  try {
    const descendantPid = await readPublishedPid(pidFile);
    launcher.kill("SIGHUP");
    const result = await waitForExit(launcher, 2_000);
    assert.deepEqual(result, { code: 129, signal: null });
    await assertProcessGone(descendantPid);
  } finally {
    try { launcher.kill("SIGKILL"); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
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

test("Windows teardown uses PowerShell descendant cleanup when taskkill fails", () => {
  const calls = [];
  const child = { killed: false, pid: 4321 };

  const complete = terminateProcessTree(child, "SIGTERM", {
    platform: "win32",
    runTaskkill() { return { status: 1 }; },
    runPowershell(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(complete, true);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].args.at(-1), "4321");
  assert.deepEqual(calls[0].options, { stdio: "ignore", windowsHide: true });
});

test("Windows teardown reports incomplete descendant cleanup when both tree killers fail", () => {
  const signals = [];
  const failures = [];
  const child = {
    killed: false,
    pid: 4321,
    kill(signal) { signals.push(signal); },
  };

  const complete = terminateProcessTree(child, "SIGTERM", {
    platform: "win32",
    runTaskkill() { return { status: 1 }; },
    runPowershell() { return { status: 1 }; },
    reportFailure(message) { failures.push(message); },
  });

  assert.equal(complete, false);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.match(failures[0], /descendants may still be running/i);
});
