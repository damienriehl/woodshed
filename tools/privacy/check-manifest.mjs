#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function inventory(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(root, target));
    else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return files;
}

export async function verifyManifest(root, allowed) {
  const actual = (await inventory(root)).sort();
  const expected = [...allowed].sort();
  return {
    unexpected: actual.filter((file) => !expected.includes(file)),
    missing: expected.filter((file) => !actual.includes(file)),
  };
}

async function main() {
  const root = process.cwd();
  const manifestPath = path.join(root, "tools/privacy/public-files.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const result = await verifyManifest(root, manifest.files);
  for (const file of result.unexpected) console.error(`unreviewed public path: ${file}`);
  for (const file of result.missing) console.error(`manifest path is missing: ${file}`);
  if (result.unexpected.length || result.missing.length) process.exitCode = 1;
  else console.log("Public file manifest passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
