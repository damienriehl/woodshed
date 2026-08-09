#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { scanBuffer, scanPaths } from "./scanner.mjs";

const options = { allowExamplePlaceholders: true };

function invokeGit(arguments_, cwd = process.cwd()) {
  const run = spawnSync("git", arguments_, { cwd, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error("Git inventory failed");
  return run.stdout;
}

export async function runPrivacyScan({ cwd = process.cwd(), modes = new Set(["--worktree"]), explicit = [], git = (args) => invokeGit(args, cwd) } = {}) {
  const findings = [];
  const errors = [];
  async function scanFileList(files) {
    const absolute = files.map((file) => path.isAbsolute(file) ? file : path.join(cwd, file));
    const result = await scanPaths(absolute, options);
    findings.push(...result.findings);
    errors.push(...result.errors);
  }
  try {
    if (modes.has("--tracked")) {
      const files = git(["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
      await scanFileList(files);
    }
    if (modes.has("--history")) {
      const objects = git(["rev-list", "--objects", "--all"]).toString("utf8").split("\n").filter(Boolean);
      for (const line of objects) {
        const separator = line.indexOf(" ");
        if (separator < 0) continue;
        const oid = line.slice(0, separator);
        const label = `history:${line.slice(separator + 1)}`;
        const type = git(["cat-file", "-t", oid]).toString("utf8").trim();
        if (type === "blob") findings.push(...scanBuffer(label, git(["cat-file", "blob", oid]), options));
      }
    }
    if (modes.has("--worktree")) await scanFileList([cwd]);
    if (explicit.length) await scanFileList(explicit);
  } catch {
    errors.push({ path: "repository", error: "inventory-failed" });
  }
  return { findings, errors };
}

async function main() {
  const args = process.argv.slice(2);
  const modes = new Set(args.filter((arg) => arg.startsWith("--")));
  const explicit = args.filter((arg) => !arg.startsWith("--"));
  if (modes.size === 0 && explicit.length === 0) modes.add("--worktree");
  const { findings, errors } = await runPrivacyScan({ modes, explicit });
  for (const finding of findings) console.error(`privacy finding: ${finding.rule} in ${finding.path}`);
  for (const error of errors) console.error(`privacy scan error: ${error.error} at ${error.path}`);
  if (findings.length || errors.length) process.exitCode = 1;
  else console.log("Privacy scan passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
