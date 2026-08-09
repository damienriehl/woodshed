# Architecture

Woodshed is a contract-first parallel rebuild. The active private Hootenanny remains authoritative until each capability independently passes privacy, conformance, rollback, and operational gates.

The future system centers a continuing Community containing many Events and a shared music library. Runtime-neutral domain and application contracts will sit behind adapters. Node with SQLite is the reference runtime; Cloudflare D1 and Durable Objects provide an early, materially different conformance target.

Capability authority advances explicitly:

`legacy-authoritative → shadow-imported → conformance-verified → woodshed-authoritative → legacy-retired`

Unknown authority fails closed, and only one writer is permitted. Public migration code consumes neutral, versioned snapshots and has no credentials or write path to the private source.

## Operational design rules

- Start public artifacts from reviewed allowlisted manifests and clean history.
- Bind releases, migrations, and cleanup to exact immutable identities.
- Make cleanup identity-scoped and re-entrant; a retry must not broaden its target.
- Preserve phase-aware failure evidence—inventory, validation, staging, commit, or cleanup—without logging sensitive contents.
- Keep public contracts portable; private hosts and operational scripts are not architectural dependencies.
