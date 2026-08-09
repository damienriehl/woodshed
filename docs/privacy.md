# Privacy boundary

The public Woodshed repository is independent from the private, active Hootenanny system. Private history is never filtered, rewritten, or transplanted here. Reviewed reusable behavior may be reimplemented through neutral contracts; private data and operations stay outside this repository.

## Public-safe inputs

- Generated synthetic people, communities, songs, events, and ballots
- Reserved example domains and documented placeholders
- Licensed assets whose provenance has been reviewed

PII, credentials, bearer or capability tokens, private hosts, production SQL, databases, backups, archives, logs, screenshots, recordings, traces, and generated deployment output are prohibited. `.gitignore` is not a privacy boundary: the worktree scanner deliberately examines ignored build-style directories.

The scanner reports only the rule and path, never the matched value. Unreadable inputs and inventory failures fail closed. Release checks scan the worktree, Git index, and reachable history. CI and demonstrations must run without production credentials.

Private compatibility snapshots belong in access-controlled private infrastructure with bounded retention. Public fixtures may preserve structural edge cases only after an allowlisted transformation and a successful privacy scan.

Storage conformance uses generated identifiers and titles only. Miniflare persists D1 state in a fresh operating-system temporary directory that the test removes; neither that directory nor any private snapshot belongs in the repository, CI artifacts, logs, or screenshots.

Calendar integrations request free/busy scope by default and do not ingest calendar titles. Provider callbacks and notification destinations use opaque references. Disconnecting a provider revokes access and deletes callback-derived state; bounded delivery receipts remain only when needed for idempotency and audit. See [Arrangement and rehearsal coordination](rehearsal-coordination.md).

Live mode stores bounded event operations and checkpoints in IndexedDB on a user’s device. Device credentials are rotatable and must not be stored in browser key-value storage; audit rows omit raw command payloads. Logout, event close, revocation, expiry, and “Clear this device” are deletion boundaries. Service-worker caches contain the public application shell, never private API responses.
