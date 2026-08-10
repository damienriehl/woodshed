import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const apiPort = process.env.WOODSHED_API_PORT ?? "3100";
const webPort = process.env.WOODSHED_WEB_PORT ?? "4174";
const spawnOptions = (env) => ({ stdio: "inherit", env, detached: process.platform !== "win32" });
const children = [
  spawn(npm, ["run", "dev", "-w", "@woodshed/api-node", "--", "--demo"], spawnOptions({ ...process.env, PORT: apiPort, WOODSHED_ORIGIN: `http://127.0.0.1:${webPort}` })),
  spawn(npm, ["run", "dev", "-w", "@woodshed/web"], spawnOptions({ ...process.env, WOODSHED_API_PORT: apiPort, WOODSHED_WEB_PORT: webPort })),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed && child.pid) {
    if (process.platform === "win32") child.kill(signal);
    else { try { process.kill(-child.pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; } }
  }
}

let requestedSignal = null;
process.on("SIGINT", () => { requestedSignal = "SIGINT"; stop("SIGINT"); });
process.on("SIGTERM", () => { requestedSignal = "SIGTERM"; stop("SIGTERM"); });

const exits = children.map((child) => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
}));
try {
  const first = await Promise.race(exits);
  if (first.code !== 0) process.exitCode = first.code ?? (first.signal === "SIGINT" ? 130 : first.signal === "SIGTERM" ? 143 : 1);
} catch (error) {
  console.error("Woodshed development launcher failed:", error instanceof Error ? error.message : "unknown child-process error");
  process.exitCode = 1;
} finally {
  stop(requestedSignal ?? "SIGTERM");
  await Promise.allSettled(exits);
}
