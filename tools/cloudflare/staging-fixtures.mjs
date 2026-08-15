import { createHash } from "node:crypto";

function safeRunId(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(runId)) throw new Error("valid run ID is required for synthetic fixtures");
  return createHash("sha256").update(runId).digest("hex").slice(0, 16);
}

export function createSyntheticFixturePlan({ runId, organizerToken, preFixtureBookmark }) {
  if (typeof organizerToken !== "string" || organizerToken.length < 8) throw new Error("organizer token is required");
  if (typeof preFixtureBookmark !== "string" || !preFixtureBookmark) throw new Error("pre-fixture bookmark is required");
  const suffix = safeRunId(runId);
  const communityId = `community_staging_${suffix}`;
  const eventId = `event_staging_${suffix}`;
  const organizerParticipationId = `participation_staging_${suffix}`;
  const songIds = [`song_staging_${suffix}_a`, `song_staging_${suffix}_b`];
  const deviceInstallationId = `device_staging_${suffix}`;
  const operationIds = Object.freeze({
    join: `join_staging_${suffix}`,
    ballot: `ballot_staging_${suffix}`,
    proposal: `proposal_staging_${suffix}`,
    authority: `authority_staging_${suffix}`,
    live: `live_staging_${suffix}`,
  });
  const tokenHash = createHash("sha256").update(organizerToken).digest("hex");
  const rows = [
    { table: "communities", key: communityId },
    { table: "events", key: eventId },
    ...songIds.map((key) => ({ table: "canonical_songs", key })),
    ...songIds.map((key) => ({ table: "event_eligible_songs", key: `${eventId}:${key}` })),
    { table: "guest_participations", key: organizerParticipationId },
    { table: "participant_sessions", key: tokenHash },
  ];
  return Object.freeze({
    runId, preFixtureBookmark, communityId, eventId, organizerParticipationId, songIds,
    deviceInstallationId, durableObjectIdentity: eventId, operationIds, tokenHash, rows,
    parentChildTables: ["communities", "events", "canonical_songs", "event_eligible_songs", "guest_participations", "participant_sessions", "open_join_receipts", "ballots", "ballot_versions", "choice_proposals", "live_operation_receipts", "live_audit_events", "live_queue_entries"],
  });
}

function publicFixtureOwnership(plan) {
  return {
    preFixtureBookmark: plan.preFixtureBookmark,
    communityId: plan.communityId,
    eventId: plan.eventId,
    organizerParticipationId: plan.organizerParticipationId,
    songIds: [...plan.songIds],
    deviceInstallationId: plan.deviceInstallationId,
    durableObjectIdentity: plan.durableObjectIdentity,
    operationIds: { ...plan.operationIds },
    tokenHash: plan.tokenHash,
    rows: plan.rows.map(({ table, key }) => ({ table, key })),
    parentChildTables: [...plan.parentChildTables],
  };
}

export async function seedSyntheticFixtures({ journal, plan, persistJournal, inspect, seed }) {
  if (journal.phase !== "worker-deployed" || plan.runId !== journal.runId) throw new Error("fixture plan does not belong to deployed run");
  if (![persistJournal, inspect, seed].every((fn) => typeof fn === "function")) throw new Error("fixture boundaries are required");
  journal.acceptance = { status: "planned", cleanupComplete: false, fixturePlan: publicFixtureOwnership(plan) };
  journal.mutations.push({ kind: "synthetic-fixture-batch", operationId: plan.operationIds.join, status: "planned" });
  await persistJournal(journal);

  const exact = (state) => state?.complete === true && state.count === plan.rows.length;
  const before = await inspect(plan);
  if (exact(before)) return { reconciled: true, count: before.count };
  if (before?.count) throw new Error("partial synthetic fixture state requires quarantine");
  try {
    await seed(plan);
  } catch (error) {
    const afterLoss = await inspect(plan);
    if (exact(afterLoss)) return { reconciled: true, count: afterLoss.count };
    throw new Error("fixture seed failed; run requires quarantine", { cause: error });
  }
  const after = await inspect(plan);
  if (!exact(after)) throw new Error("fixture seed postcondition failed; run requires quarantine");
  return { reconciled: false, count: after.count };
}
