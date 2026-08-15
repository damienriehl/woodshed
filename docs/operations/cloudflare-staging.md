# Cloudflare staging recovery and teardown

This runbook governs the disposable Cloudflare staging stack only. A successful rehearsal validates the experimental adapter subset; it does not authorize production promotion, Hootenanny cutover, or retirement of another runtime.

## Evidence and observability

Keep the exact ownership journal and account inventory private. Shareable evidence may contain phase outcomes, counts, timestamps, source/config digests, deployment and resource IDs, and absence booleans. It must not contain cookies, authorization headers, request or response bodies, ballots, session or device credentials, secret values, database results, or hashes derived from user-shaped values. An unexpected Worker exception, D1 failure, Durable Object failure, credential exposure, or 5xx blocks completion and produces a redacted report naming the incident owner and safe next action.

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
6. The time-bounded deployment token; verify token introspection/authentication is inactive.

Re-read ownership immediately before every mutation. After every delete, query that storage domain and record absence. Teardown is re-entrant: an already absent owned resource is success for that step, while an identity mismatch or unexpected dependent is an incident. Do not report cleanup complete—or claim zero residue—until route/hostname, secrets and credentials, Worker/version, Durable Object namespace/state, D1 database, and deployment token are each proven absent. If any proof fails, keep the origin quarantined and the incident owner assigned.

Finally compare sanitized pre/post account metadata and the allowlisted mutation journal. Any production or Hootenanny deployment, migration, route, DNS, or Durable Object lifecycle change blocks completion.
