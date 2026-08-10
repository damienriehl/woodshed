import { spawn } from "node:child_process";
import { createTeardownController, signalExitCode } from "./dev-lifecycle.mjs";
import { terminateProcessTree } from "./process-tree.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const apiPort = process.env.WOODSHED_API_PORT ?? "3100";
const webPort = process.env.WOODSHED_WEB_PORT ?? "4174";
const spawnOptions = (env) => ({ stdio: "inherit", env, detached: process.platform !== "win32" });
const children = [
  spawn(npm, ["run", "dev", "-w", "@woodshed/api-node", "--", "--demo"], spawnOptions({ ...process.env, PORT: apiPort, WOODSHED_ORIGIN: `http://127.0.0.1:${webPort}` })),
  spawn(npm, ["run", "dev", "-w", "@woodshed/web"], spawnOptions({ ...process.env, WOODSHED_API_PORT: apiPort, WOODSHED_WEB_PORT: webPort })),
];

const teardown = createTeardownController({ children, terminate: terminateProcessTree });
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => teardown.handleSignal(signal));
}

const exits = children.map((child) => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
}));
try {
  const first = await Promise.race(exits);
  if (teardown.requestedSignal) process.exitCode = signalExitCode(teardown.requestedSignal);
  else if (first.code !== 0) process.exitCode = first.code ?? signalExitCode(first.signal);
} catch (error) {
  console.error("Woodshed development launcher failed:", error instanceof Error ? error.message : "unknown child-process error");
  process.exitCode = 1;
} finally {
  teardown.stop(teardown.requestedSignal ?? "SIGTERM");
  await Promise.allSettled(exits);
  teardown.settled();
}
