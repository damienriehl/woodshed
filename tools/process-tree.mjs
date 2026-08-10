import { spawnSync } from "node:child_process";

const POWERSHELL_TREE_KILL = String.raw`
$rootPid = [int]$args[0]
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$pending = [System.Collections.Generic.Queue[int]]::new()
$pending.Enqueue($rootPid)
$descendants = [System.Collections.Generic.List[int]]::new()
while ($pending.Count -gt 0) {
  $parent = $pending.Dequeue()
  foreach ($process in $all | Where-Object ParentProcessId -eq $parent) {
    $descendants.Add([int]$process.ProcessId)
    $pending.Enqueue([int]$process.ProcessId)
  }
}
for ($index = $descendants.Count - 1; $index -ge 0; $index--) {
  Stop-Process -Id $descendants[$index] -Force -ErrorAction SilentlyContinue
}
Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 50
$targets = @($rootPid) + @($descendants)
if (Get-Process -Id $targets -ErrorAction SilentlyContinue) { exit 1 }
`;

export function terminateProcessTree(child, signal = "SIGTERM", dependencies = {}) {
  if (child.killed || !child.pid) return true;

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

    if (result?.status === 0) return true;

    const runPowershell = dependencies.runPowershell ?? spawnSync;
    let powershellResult;
    try {
      powershellResult = runPowershell(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_TREE_KILL, String(child.pid)],
        { stdio: "ignore", windowsHide: true },
      );
    } catch {
      powershellResult = { status: 1 };
    }
    if (powershellResult?.status === 0) return true;

    // A direct signal cannot guarantee descendant cleanup, but it is still safer
    // than leaving the known parent untouched. Report the incomplete teardown.
    try {
      child.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    } finally {
      const reportFailure = dependencies.reportFailure ?? console.error;
      reportFailure(`Could not terminate the complete Windows process tree rooted at PID ${child.pid}; descendants may still be running.`);
    }
    return false;
  }

  const killProcess = dependencies.killProcess ?? process.kill;
  try { killProcess(-child.pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
  return true;
}
