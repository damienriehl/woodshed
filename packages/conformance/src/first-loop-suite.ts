import assert from "node:assert/strict";
import { test } from "node:test";

import { KernelError, type FirstLoopIds, type FirstLoopStorage } from "./adapter.ts";

export const SYNTHETIC_FIRST_LOOP_IDS: FirstLoopIds = {
  community: "community_demo_alpha",
  otherCommunity: "community_demo_beta",
  event: "event_demo_show",
  participation: "participation_demo_guest",
  songA: "song_demo_alpha",
  songB: "song_demo_beta",
  songC: "song_demo_gamma",
};

const IDS = SYNTHETIC_FIRST_LOOP_IDS;

export function firstLoopCommand(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    aggregateType: "ballot",
    aggregateId: `${IDS.participation}:${IDS.event}`,
    scope: "event",
    communityId: IDS.community,
    eventId: IDS.event,
    actorId: IDS.participation,
    capability: "ballot:replace",
    operationId: "operation_demo_0001",
    expectedRevision: 0,
    issuedAt: "2030-01-01T12:00:00.123Z",
    expiresAt: "2030-01-01T12:10:00.456Z",
    ...overrides,
  };
}

type Harness = {
  open(): Promise<FirstLoopStorage>;
  reopen?(kernel: FirstLoopStorage): Promise<FirstLoopStorage>;
  cleanup(): Promise<void>;
};

export function registerFirstLoopStorageConformance(name: string, createHarness: () => Promise<Harness>) {
  async function withKernel(run: (kernel: FirstLoopStorage, harness: Harness) => Promise<void>) {
    const harness = await createHarness();
    let kernel = await harness.open();
    try {
      await kernel.migrate();
      await kernel.seedSyntheticFirstLoop(IDS);
      await run(kernel, harness);
    } finally {
      await kernel.close();
      await harness.cleanup();
    }
  }

  async function rejectsCode(action: () => Promise<unknown> | unknown, code: KernelError["code"]) {
    await assert.rejects(async () => action(), (error: unknown) => error instanceof KernelError && error.code === code);
  }

  test(`${name}: migration replay preserves seeded state`, async () => {
    await withKernel(async (kernel, harness) => {
      await kernel.migrate();
      assert.ok((await kernel.count("schema_migrations")) >= 1);
      assert.equal(await kernel.count("communities"), 2);
      if (harness.reopen) {
        kernel = await harness.reopen(kernel);
        await kernel.migrate();
        assert.equal(await kernel.count("communities"), 2);
      }
    });
  });

  test(`${name}: ranked ballot mutation writes state, audit and replay receipt`, async () => {
    await withKernel(async (kernel) => {
      const now = new Date("2030-01-01T12:01:00.789Z");
      const first = await kernel.replaceBallot(firstLoopCommand(), [IDS.songB, IDS.songA], now);
      assert.deepEqual(first, { method: "ranked-choice", revision: 1, rankings: [IDS.songB, IDS.songA] });
      assert.deepEqual(await kernel.replaceBallot(firstLoopCommand(), [IDS.songB, IDS.songA], new Date("2030-01-01T12:02:00.111Z")), first);
      assert.equal(await kernel.count("ballot_versions"), 1);
      assert.equal(await kernel.count("audit_events"), 1);
      assert.equal(await kernel.count("idempotency_receipts"), 1);
      assert.equal(await kernel.latestBallotCreatedAt(), now.toISOString());
      assert.deepEqual(await kernel.invariantViolations(), []);
    });
  });

  test(`${name}: errors use the canonical taxonomy`, async () => {
    await withKernel(async (kernel) => {
      const now = new Date("2030-01-01T12:01:00.789Z");
      await rejectsCode(() => kernel.replaceBallot(firstLoopCommand({ capability: "event:update" }), [IDS.songA], now), "denied");
      await rejectsCode(() => kernel.replaceBallot(firstLoopCommand({ aggregateType: "event" }), [IDS.songA], now), "invalid-command");
      await rejectsCode(() => kernel.replaceBallot(firstLoopCommand(), [IDS.songA], new Date("2030-01-01T12:10:00.457Z")), "expired");
      await rejectsCode(() => kernel.replaceBallot(firstLoopCommand(), [IDS.songA], new Date("2030-01-01T11:59:59.999Z")), "not-yet-valid");
      await rejectsCode(() => kernel.replaceBallot(firstLoopCommand(), [IDS.songC, IDS.songC], now), "invalid-ballot");
      await rejectsCode(
        () => kernel.replaceBallot(firstLoopCommand({ operationId: "operation_demo_ineligible" }), [IDS.songC], now),
        "invalid-ballot",
      );
      await kernel.replaceBallot(firstLoopCommand(), [IDS.songA], now);
      await rejectsCode(() => kernel.replaceBallot(firstLoopCommand(), [IDS.songB], now), "replay-mismatch");
      await rejectsCode(() => kernel.replaceBallot(firstLoopCommand({ operationId: "operation_demo_stale" }), [IDS.songB], now), "conflict");
      await rejectsCode(() => kernel.replaceBallot(firstLoopCommand({ operationId: "operation_demo_cross", communityId: IDS.otherCommunity }), [IDS.songA], now), "denied");
    });
  });

  test(`${name}: revoked participation fails closed`, async () => {
    await withKernel(async (kernel) => {
      await kernel.revokeParticipation(IDS.participation, "2030-01-01T12:00:30.500Z");
      await rejectsCode(() => kernel.replaceBallot(firstLoopCommand(), [IDS.songA], new Date("2030-01-01T12:01:00.789Z")), "denied");
    });
  });

  test(`${name}: injected batch faults roll back state, audit and receipt`, async () => {
    for (const point of ["after-state", "after-audit"] as const) {
      await withKernel(async (kernel) => {
        await rejectsCode(
          () => kernel.replaceBallot(firstLoopCommand({ operationId: `operation_demo_${point}` }), [IDS.songA], new Date("2030-01-01T12:01:00.789Z"), point),
          "storage-failure",
        );
        assert.equal(await kernel.count("ballot_versions"), 0);
        assert.equal(await kernel.count("audit_events"), 0);
        assert.equal(await kernel.count("idempotency_receipts"), 0);
      });
    }
  });

  test(`${name}: compare-and-swap permits one writer at a revision`, async () => {
    await withKernel(async (kernel) => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => kernel.replaceBallot(firstLoopCommand({ operationId: "operation_demo_left" }), [IDS.songA], new Date("2030-01-01T12:01:00.789Z"))),
        Promise.resolve().then(() => kernel.replaceBallot(firstLoopCommand({ operationId: "operation_demo_right" }), [IDS.songB], new Date("2030-01-01T12:01:00.789Z"))),
      ]);
      assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
      const rejected = results.find(({ status }) => status === "rejected") as PromiseRejectedResult;
      assert.ok(rejected.reason instanceof KernelError);
      assert.equal(rejected.reason.code, "conflict");
    });
  });
}
