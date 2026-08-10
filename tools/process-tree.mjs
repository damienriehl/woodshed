import { spawnSync } from "node:child_process";

export function terminateProcessTree(child, signal = "SIGTERM", dependencies = {}) {
  if (child.killed || !child.pid) return;

  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32") {
    const runTaskkill = dependencies.runTaskkill ?? spawnSync;
    let result;
    try {
      result = runTaskkill(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
    } catch {
      result = { status: 1 };
    }

    if (result?.status !== 0) {
      try { child.kill(signal); }
      catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
    return;
  }

  const killProcess = dependencies.killProcess ?? process.kill;
  try { killProcess(-child.pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
}
