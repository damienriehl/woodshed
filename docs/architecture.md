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

Live authority epochs, archives, private migration payloads, assignments, rehearsals, and offline performance coordination remain outside this kernel and belong to later implementation units.

## Operational design rules

- Start public artifacts from reviewed allowlisted manifests and clean history.
- Bind releases, migrations, and cleanup to exact immutable identities.
- Make cleanup identity-scoped and re-entrant; a retry must not broaden its target.
- Preserve phase-aware failure evidence—inventory, validation, staging, commit, or cleanup—without logging sensitive contents.
- Keep public contracts portable; private hosts and operational scripts are not architectural dependencies.
