# Cloudflare staging recovery and teardown

This runbook governs the disposable Cloudflare staging stack only. A successful rehearsal validates the experimental adapter subset; it does not authorize production promotion, Hootenanny cutover, or retirement of another runtime.

## Evidence and observability

Keep the exact ownership journal and account inventory private. The final shareable packet contains only phase outcomes, counts, timestamps, source/config/schema/protected-inventory digests, and absence booleans. It must not contain account, deployment, database, Worker, route, hostname, or token identifiers; cookies; authorization headers; request or response bodies; ballots; session or device credentials; secret values; database results; or hashes derived from user-shaped values. An unexpected Worker exception, D1 failure, Durable Object failure, credential exposure, or 5xx blocks completion and produces a redacted report naming the incident owner and safe next action.

The private journal remains available through the +1-hour and +24-hour absence/audit checks after teardown. After an incident, retain it through resolution and the following 24 hours. Only then may the operator dispose of it under the private retention policy.

## Rollback boundaries

Worker rollback is permitted only between two verified versions with the same checked-in legacy `migrations` array lifecycle and compatible D1 schema, Durable Object stored-value shape, bindings, and secret names. The first SQLite Durable Object lifecycle deployment is forward-fix-only. A pre-lifecycle or lifecycle-changing version is never a rollback target.

D1 Time Travel is a separate, destructive recovery domain. Before restore, withdraw the origin, verify it is no longer writable, confirm the exclusive run lease and last-write identity, and use only the journaled bookmark. After restore, revalidate the migration ledger, schema fingerprint, foreign keys, aggregate counts/digests, and application behavior. D1 restore does not restore Durable Object state.

## Quarantine and teardown

Every post-write failure is a partial-deployment incident. Quarantine the origin before restore or teardown, preserve the bookmark and frozen identities, and never automatically restore persistent state. A corrupt journal, owner/run mismatch, changed last-write identity, unreadable inventory, or unexpected dependent authorizes no deletion.

Destroy only identities explicitly owned by the run journal, in dependency order:

1. Route or `workers.dev` exposure and any run-owned hostname.
2. Ephemeral participant/organizer credentials and the run-only Worker secret.
3. Worker versions/service.
4. The run-owned Durable Object class/namespace through a new, uniquely tagged `deleted_classes` entry in the existing legacy migration array; do not migrate this rehearsal to declarative `exports`.
5. The disposable D1 database, including its intentionally immutable history.
6. Any journal-owned token minted by the run; verify that minted token is inactive. The operator-supplied token is borrowed and is never a teardown target.

Re-read ownership immediately before every mutation. After every delete, query that storage domain and record absence. Teardown is re-entrant: an already absent owned resource is success for that step, while an identity mismatch or unexpected dependent is an incident. Do not report cleanup complete—or claim zero residue—until route/hostname, secrets and credentials, Worker/version, Durable Object namespace/state, D1 database, and any run-minted token are each proven absent. If any proof fails, keep the origin quarantined and the incident owner assigned.

Finally compare sanitized pre/post account metadata and the allowlisted mutation journal. Any production or Hootenanny deployment, migration, route, DNS, or Durable Object lifecycle change blocks completion.

## Shared-account contract

The rehearsal runs in the owner's existing Cloudflare account. Worker and D1 API tokens are account-scoped, so a driver defect can reach an unrelated live resource. The non-bypassable mitigations are: `inventory.forbidden` is a target denylist; a declared protected identity may be present but may never be targeted; an undeclared production-, `prod`-, or Hootenanny-shaped Worker, D1 database, route, or origin refuses preflight; created names remain staging-only; every mutation requires journal ownership; and the account identity is re-read immediately before every write. `forbidden.accountIds` lists only other accounts that staging must never touch and must never contain the staging account itself.

The operator-supplied `CLOUDFLARE_API_TOKEN` is borrowed. It must cover the staging Worker/D1 operations in this run, account-wide Worker-name inventory, zone route reads, Worker custom-domain reads, and authenticated account/subdomain inspection. Preflight records only that it is present and active; the journal does not claim ownership of it, and teardown never revokes it. Only a token explicitly recorded as journal-owned and run-minted is eligible for teardown revocation. The inventory origin must be the exact authenticated run-owned `workers.dev` origin; a merely similar public hostname is rejected before credential-bearing HTTPS. The operator controls expiry or revocation of the borrowed token outside the driver.

## Operator sequence

Start from the frozen clean commit named by the private inventory. Keep the inventory and journal paths outside the checkout. Set values for these names in the operator process without putting them in shell history, command arguments, repository files, or logs:

- `CLOUDFLARE_API_TOKEN`
- `LIVE_COMMAND_SECRET`
- `WOODSHED_STAGING_ORGANIZER_TOKEN`
- `STAGING_INVENTORY_PATH`
- `STAGING_JOURNAL_PATH`
- `STAGING_RUN_ID`
- `STAGING_OWNER`

Run local gates first. None of these commands contacts Cloudflare:

```sh
npm run verify:release -- --expected-ref "$(git rev-parse HEAD)"
npm run test:deployment
npm run privacy:release
npm run lint
npm run typecheck
npm run smoke:cloudflare
npm run cloudflare:staging:version
```

Then execute the live phases. Every invocation names the literal staging environment; omitting it or selecting a default/top-level environment fails closed.

```sh
npm run cloudflare:staging -- preflight --env staging --inventory "$STAGING_INVENTORY_PATH"
npm run cloudflare:staging -- plan --env staging --inventory "$STAGING_INVENTORY_PATH" --journal "$STAGING_JOURNAL_PATH" --run-id "$STAGING_RUN_ID" --owner "$STAGING_OWNER"
npm run cloudflare:staging -- status --env staging --journal "$STAGING_JOURNAL_PATH" --run-id "$STAGING_RUN_ID" --owner "$STAGING_OWNER"
npm run cloudflare:staging -- apply --env staging --inventory "$STAGING_INVENTORY_PATH" --journal "$STAGING_JOURNAL_PATH" --run-id "$STAGING_RUN_ID" --owner "$STAGING_OWNER"
npm run cloudflare:staging -- verify --env staging --inventory "$STAGING_INVENTORY_PATH" --journal "$STAGING_JOURNAL_PATH" --run-id "$STAGING_RUN_ID" --owner "$STAGING_OWNER"
npm run cloudflare:staging -- teardown --env staging --inventory "$STAGING_INVENTORY_PATH" --journal "$STAGING_JOURNAL_PATH" --run-id "$STAGING_RUN_ID" --owner "$STAGING_OWNER"
```

`preflight` and `plan` perform no Cloudflare mutation. Review the private plan/journal after `plan` and before `apply`. `apply` is migration-first and origin-last. `verify` uses real HTTPS, exercises the participant/security/authority/live-command boundaries, records same-lifecycle compatibility, states that the first Durable Object lifecycle is forward-fix-only, and quarantines the origin. `teardown` calls the dependency-ordered removers, never revokes the borrowed operator token, requires immediate per-domain absence, and writes `<journal>.evidence.json` with only counts, booleans, timestamps, and source/config/schema digests.

Wrangler runs with an isolated generated home and an explicit empty environment file; it does not inherit ambient Cloudflare credentials or load repository dotenv/dev-var files. Successful teardown deletes the run-specific generated configuration while retaining the private external journal and evidence packet for delayed audits. The hostname domain is journaled explicitly as not provisioned and receives its own absence observation because this driver accepts only the authenticated run-owned `workers.dev` origin; it never creates a custom hostname.

At +1 hour and +24 hours, set `CLOUDFLARE_API_TOKEN` to a read-capable audit credential and run:

```sh
npm run cloudflare:staging -- absence-check --env staging --inventory "$STAGING_INVENTORY_PATH" --journal "$STAGING_JOURNAL_PATH" --run-id "$STAGING_RUN_ID" --owner "$STAGING_OWNER"
```

Retain the private journal until both checks pass. A failed or interrupted phase is re-entered with the same inventory, journal, run ID, and owner. Never start a second run against the graph, replay an uncertain migration blindly, restore D1 automatically, or claim that D1 recovery restored Durable Object state.
