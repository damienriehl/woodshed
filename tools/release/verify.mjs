#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const marker = process.argv.indexOf("--expected-ref");
const expected = marker >= 0 ? process.argv[marker + 1] : undefined;
if (!expected || !/^[a-f0-9]{40,64}$/i.test(expected)) {
  console.error("release verification requires --expected-ref with a full immutable commit ID");
  process.exit(2);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
}

if (run("git", ["rev-parse", "HEAD"]) !== expected) {
  console.error("release identity does not match checked-out HEAD");
  process.exit(1);
}
if (run("git", ["status", "--porcelain"]) !== "") {
  console.error("release verification requires a clean worktree");
  process.exit(1);
}
run(process.execPath, ["tools/privacy/scan.mjs", "--tracked", "--history", "--worktree"]);
console.log(`Release privacy verification passed for ${expected}.`);
