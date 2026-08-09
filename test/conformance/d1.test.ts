import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Miniflare } from "miniflare";

import { registerFirstLoopStorageConformance } from "../../packages/conformance/src/first-loop-suite.ts";
import { D1Kernel } from "../../packages/storage-d1/src/index.ts";

const COMPATIBILITY_DATE = "2025-07-18";

registerFirstLoopStorageConformance("Miniflare D1", async () => {
  const persist = await mkdtemp(path.join(os.tmpdir(), "woodshed-d1-"));
  const migrations = await Promise.all(["001_first_loop.sql", "002_participant_choice.sql"].map(async (name) => ({
    name,
    sql: await readFile(new URL(`../../migrations/d1/${name}`, import.meta.url), "utf8"),
  })));
  let miniflare: Miniflare | undefined;

  async function open() {
    miniflare = new Miniflare({
      compatibilityDate: COMPATIBILITY_DATE,
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "woodshed-conformance" },
      d1Persist: persist,
    });
    return new D1Kernel(await miniflare.getD1Database("DB"), migrations, async () => {
      await miniflare?.dispose();
      miniflare = undefined;
    });
  }

  return {
    open,
    async reopen(kernel) { await kernel.close(); return open(); },
    async cleanup() { await miniflare?.dispose(); await rm(persist, { recursive: true, force: true }); },
  };
});
