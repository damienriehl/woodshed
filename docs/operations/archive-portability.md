# Community archive portability

The `woodshed/community-archive/v1` profile is distinct from private Hootenanny test snapshots. It contains canonical application records for events, consented people, consent records, songs, profiles, arrangements, tombstones, audit continuity, and export-authorized assets. Raw databases are never portable archives.

Import is a dry-run-first operation. A new community is the default destination. Import into an existing community requires an explicit merge policy and a conflict report. Valid records are staged outside the active namespace and become visible only through one atomic commit pointer. Interrupted staging is safe to purge repeatedly.

Portability compares semantic manifests: record counts, relationship graph, consent scopes, tombstones, audit head, and authorized asset hashes. This catches privilege or consent drift without requiring destinations to share database internals. Resource limits reject excessive bytes, records, assets, nesting, references, unsafe names, unsupported types, and future schemas before commit.

Archive export authorization is a server-owned port. A deployment must inject an `ArchiveExportAuthorizationPort` backed by its authenticated membership and role store; the coordinator passes only the authenticated actor ID and resource community ID to that port. The default implementation denies every export. Request payloads do not carry an accepted capability or role claim, so a caller cannot authorize itself, and grants are scoped to one actor-community pair. The in-memory authorizer exists for conformance tests and local composition, not as a production identity store.
