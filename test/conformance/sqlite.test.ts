import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registerFirstLoopStorageConformance } from "../../packages/conformance/src/first-loop-suite.ts";
import { SqliteKernel } from "../../packages/storage-sqlite/src/index.ts";

registerFirstLoopStorageConformance("SQLite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "woodshed-sqlite-conformance-"));
  const filename = path.join(directory, "kernel.sqlite");
  return {
    async open() { return new SqliteKernel(filename); },
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
});
