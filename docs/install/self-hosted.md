# Self-hosted installation

The Node/SQLite destination is the technical self-hosting path. Copy the example configuration, mount key material read-only from a secret manager or protected file, and keep the database and encrypted archives on distinct backed-up volumes. The container binds to loopback by default; put authenticated TLS termination in front of it.

Before serving traffic, run `npm ci`, `npm test`, `npm run typecheck`, `npm run privacy`, and the operator `upgrade:dry-run` and `restore:verify` commands. Never place a private archive in the source tree, container image, logs, or CI artifacts.

The Docker manifest is an operable reference, not a claim that any particular environment is production-ready without a successful local restore drill.
