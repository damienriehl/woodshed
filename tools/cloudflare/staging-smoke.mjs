import { createEvidenceEnvelope } from "./evidence.mjs";
import { seedSyntheticFixtures } from "./staging-fixtures.mjs";

const jsonHeaders = (origin, extra = {}) => ({ origin, "x-csrf-token": "same-origin", "content-type": "application/json", ...extra });
const body = (value) => JSON.stringify(value);

async function parsed(response, expected, label) {
  if (!expected.includes(response.status)) throw new Error(`${label} returned unexpected status ${response.status}`);
  if (response.status === 204) return null;
  try { return await response.json(); } catch { throw new Error(`${label} returned malformed JSON`); }
}

export async function runDeployedAcceptance(options) {
  const { origin, journal, plan, organizerToken, fetch, persistJournal, inspectFixtures, seedFixtures, buildLiveCommand } = options;
  if (!["worker-deployed", "alias-live"].includes(journal.phase)) throw new Error("immutable deployed Worker proof is required before acceptance");
  if (origin !== journal.identity.origin || !origin.startsWith("https://")) throw new Error("accepted HTTPS origin must match the journal");
  if (typeof organizerToken !== "string" || typeof fetch !== "function" || typeof buildLiveCommand !== "function") throw new Error("acceptance boundaries are required");
  const request = (pathname, init = {}) => fetch(new URL(pathname, origin).href, init);
  journal.acceptance = { status: "starting", cleanupComplete: false };
  try {
    const fixtures = await seedSyntheticFixtures({ journal, plan, persistJournal, inspect: inspectFixtures, seed: seedFixtures });
    const discovery = await parsed(await request("/api/discovery"), [200], "discovery");
    if (!Array.isArray(discovery?.events) || !discovery.events.some(({ id }) => id === plan.eventId)) throw new Error("synthetic event is absent from discovery");

    const wrongOrigin = await request(`/api/events/${plan.eventId}/join-open`, { method: "POST", headers: jsonHeaders("https://wrong-origin.invalid"), body: body({ operationId: plan.operationIds.join }) });
    const missingCsrf = await request(`/api/events/${plan.eventId}/join-open`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: body({ operationId: plan.operationIds.join }) });
    const missingSession = await request(`/api/events/${plan.eventId}/ballot`);
    const joined = await request(`/api/events/${plan.eventId}/join-open`, { method: "POST", headers: jsonHeaders(origin), body: body({ operationId: plan.operationIds.join }) });
    await parsed(joined, [200], "join");
    const setCookie = joined.headers.get("set-cookie") ?? "";
    if (!/^woodshed_session_[0-9a-f]{16}=/.test(setCookie) || !/Path=\//.test(setCookie) || !/HttpOnly/.test(setCookie) || !/Secure/.test(setCookie) || !/SameSite=Lax/.test(setCookie)) throw new Error("join cookie contract failed");
    const cookie = setCookie.split(";", 1)[0];
    await parsed(await request(`/api/events/${plan.eventId}/context`, { headers: { cookie } }), [200], "context");
    const ballot = await parsed(await request(`/api/events/${plan.eventId}/ballot`, { headers: { cookie } }), [200], "ballot read");
    if (!Number.isSafeInteger(ballot?.revision) || !Array.isArray(ballot?.candidates)) throw new Error("ballot response contract failed");
    const rankings = ballot.candidates.map(({ id }) => id).reverse();
    const saved = await parsed(await request(`/api/events/${plan.eventId}/ballot`, { method: "PUT", headers: jsonHeaders(origin, { cookie }), body: body({ expectedRevision: ballot.revision, rankings, operationId: plan.operationIds.ballot }) }), [200], "ballot write");
    const reread = await parsed(await request(`/api/events/${plan.eventId}/ballot`, { headers: { cookie } }), [200], "ballot readback");
    if (reread.revision !== saved.revision || JSON.stringify(reread.candidates.map(({ id }) => id)) !== JSON.stringify(rankings)) throw new Error("ballot readback mismatch");
    const proposal = await parsed(await request(`/api/events/${plan.eventId}/proposals`, { method: "POST", headers: jsonHeaders(origin, { cookie }), body: body({ title: "Synthetic Staging Song", operationId: plan.operationIds.proposal }) }), [201], "proposal");
    if (proposal?.state !== "eligible") throw new Error("proposal policy contract failed");

    const participantOrganizer = await request(`/api/events/${plan.eventId}/live/authority/acquire`, { method: "POST", headers: jsonHeaders(origin, { cookie }), body: body({ deviceInstallationId: plan.deviceInstallationId }) });
    const organizerHeaders = jsonHeaders(origin, { authorization: `Bearer ${organizerToken}` });
    const authority = await parsed(await request(`/api/events/${plan.eventId}/live/authority/acquire`, { method: "POST", headers: organizerHeaders, body: body({ deviceInstallationId: plan.deviceInstallationId }) }), [200], "authority acquisition");
    if (!Number.isSafeInteger(authority?.epoch) || typeof authority?.commandCredential !== "string" || !authority.commandCredential) throw new Error("authority response contract failed");
    const liveCommand = await buildLiveCommand({ commandCredential: authority.commandCredential, authorityEpoch: authority.epoch, plan });
    if (!liveCommand || typeof liveCommand !== "object" || typeof liveCommand.entryId !== "string" || !liveCommand.entryId) throw new Error("live command contract failed");
    const liveBefore = await parsed(await request(`/api/events/${plan.eventId}/live/state`, { headers: { authorization: `Bearer ${organizerToken}` } }), [200], "initial live state");
    if (!Number.isSafeInteger(liveBefore?.revision) || !Array.isArray(liveBefore?.entries)) throw new Error("initial live state contract failed");
    if (liveBefore.entries.some(({ id }) => id === liveCommand.entryId)) throw new Error("synthetic live entry existed before command");
    const liveResult = await parsed(await request(`/api/events/${plan.eventId}/live/commands`, { method: "POST", headers: organizerHeaders, body: body(liveCommand) }), [200], "live command");
    const liveState = await parsed(await request(`/api/events/${plan.eventId}/live/state`, { headers: { authorization: `Bearer ${organizerToken}` } }), [200], "live state");
    const logout = await request("/api/logout", { method: "POST", headers: jsonHeaders(origin, { cookie }) });
    await parsed(logout, [204], "logout");
    if (!/Max-Age=0/.test(logout.headers.get("set-cookie") ?? "")) throw new Error("logout did not clear Woodshed cookies");
    const afterLogout = await request(`/api/events/${plan.eventId}/context`, { headers: { cookie } });

    const security = { wrongOrigin: wrongOrigin.status === 403, missingCsrf: missingCsrf.status === 403, missingSession: missingSession.status === 401, retiredSessionReplay: afterLogout.status === 401, participantOrganizer: participantOrganizer.status === 403 };
    if (Object.values(security).some((passed) => !passed)) throw new Error("deployed security matrix failed");
    if (!Number.isSafeInteger(liveResult?.revision) || !liveResult?.entry || typeof liveResult.entry.state !== "string" || !Number.isSafeInteger(liveState?.revision) || !Array.isArray(liveState?.entries)) throw new Error("live response contract failed");
    const exercisedEntry = liveState.entries.find(({ id }) => id === liveCommand.entryId);
    if (liveState.revision !== liveResult.revision || liveResult.entry.id !== liveCommand.entryId || !exercisedEntry || exercisedEntry.state !== liveResult.entry.state) throw new Error("live state readback mismatch");
    journal.phase = "verified";
    journal.acceptance = { ...journal.acceptance, status: "passed", cleanupComplete: false };
    const evidence = createEvidenceEnvelope({
      runId: journal.runId, sourceSha: journal.sourceSha, phase: journal.phase,
      outcomes: { acceptance: true, security, cleanupComplete: false, disposableResidueExpected: true, productionAuthority: false },
      counts: { fixtureRows: fixtures.count, choiceRevision: reread.revision, liveRevision: liveState.revision, liveEntries: Array.isArray(liveState.entries) ? liveState.entries.length : 0 },
    });
    journal.acceptanceEvidence = evidence;
    await persistJournal(journal);
    return evidence;
  } catch (error) {
    journal.phase = "verified";
    journal.acceptance = { ...journal.acceptance, status: "failed", cleanupComplete: false };
    await persistJournal(journal);
    throw error;
  }
}
