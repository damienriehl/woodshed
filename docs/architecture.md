# Architecture

Woodshed is a contract-first parallel rebuild. The active private Hootenanny remains authoritative until each capability independently passes privacy, conformance, rollback, and operational gates.

The future system centers a continuing Community containing many Events and a shared music library. Runtime-neutral domain and application contracts will sit behind adapters. Node with SQLite is the reference runtime; Cloudflare D1 and Durable Objects provide an early, materially different conformance target.

Capability authority advances explicitly:

`legacy-authoritative → shadow-imported → conformance-verified → woodshed-authoritative → legacy-retired`

Unknown authority fails closed, and only one writer is permitted. Public migration code consumes neutral, versioned snapshots and has no credentials or write path to the private source.

## First-loop kernel

The initial portable kernel is deliberately narrower than the eventual platform. `packages/contracts`, `packages/domain`, and `packages/application` contain runtime-neutral TypeScript for communities, events, guest participation, canonical songs, event song decisions, ranked ballots, proposals, command envelopes, authorization, and data classification. `packages/storage-sqlite` is the Node reference adapter; runtime-specific SQLite APIs do not cross into the portable packages.

Every mutable first-loop operation is community-scoped, revision-aware, expiring, and idempotent. The SQLite adapter commits state, an attributable audit event, and an idempotency receipt in one transaction. Immutable ballot versions retain history while a single current revision supports replacement. New eligible candidates append to an existing participant order rather than reshuffling it mid-ballot.

The conformance invariant catalog provides executable checks for current-ballot uniqueness, immutable-history references, complete audit and receipt linkage, community isolation, and non-broadening event consent. Migration files have immutable checksums and replay safely on empty or populated databases.

## First-loop storage conformance

`packages/conformance/src/adapter.ts` defines the deliberately small storage port for the participant-choice loop. The common black-box suite runs unchanged against `SqliteKernel` and `D1Kernel`; it verifies migration replay, synthetic tenant seeding, ranked ordering, millisecond timestamp preservation, capability and aggregate checks, tenant isolation, revoked participation, compare-and-swap conflicts, idempotent replay and payload mismatch, and rollback of state + audit + receipt.

The D1 adapter is tested through Miniflare's programmatic `getD1Database` API, so the second runtime is a genuine local workerd/D1 binding rather than a SQLite-shaped mock. Miniflare is pinned exactly and the test pins compatibility date `2025-07-18`. Local and deployed D1 data are separate by design. Deployments inject the reviewed, one-statement-per-line SQL migration contents into the Worker-safe adapter; the adapter itself imports no Node runtime modules. D1 applies each migration and its checksum receipt in one batch. D1 batching and result metadata remain adapter details; callers receive only the canonical first-loop result and `KernelError` taxonomy.

The shared first-loop storage proof covers participant ballot replacement. Additional suites now exercise encrypted snapshots and archives, rehearsal coordination repositories, live authority and offline replay, and the Worker entrypoint. These remain separate contracts rather than an expanded ballot-kernel interface.

Node/SQLite is the complete implemented application runtime. The Cloudflare adapter is deliberately experimental: it serves D1-backed discovery, ballot replacement, live commands, and Durable Object authority transitions, but it does not yet issue participant sessions or expose the Node runtime's proposal, draft-setlist, staffing, and rehearsal endpoints. Its asynchronous D1 coordination repository is conformance-tested but is not yet wired to an asynchronous rehearsal application service. These limitations block presenting Cloudflare as a complete deploy target.

## Operational design rules

- Start public artifacts from reviewed allowlisted manifests and clean history.
- Bind releases, migrations, and cleanup to exact immutable identities.
- Make cleanup identity-scoped and re-entrant; a retry must not broaden its target.
- Preserve phase-aware failure evidence—inventory, validation, staging, commit, or cleanup—without logging sensitive contents.
- Keep public contracts portable; private hosts and operational scripts are not architectural dependencies.
