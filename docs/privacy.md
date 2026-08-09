# Privacy boundary

The public Woodshed repository is independent from the private, active Hootenanny system. Private history is never filtered, rewritten, or transplanted here. Reviewed reusable behavior may be reimplemented through neutral contracts; private data and operations stay outside this repository.

## Public-safe inputs

- Generated synthetic people, communities, songs, events, and ballots
- Reserved example domains and documented placeholders
- Licensed assets whose provenance has been reviewed

PII, credentials, bearer or capability tokens, private hosts, production SQL, databases, backups, archives, logs, screenshots, recordings, traces, and generated deployment output are prohibited. `.gitignore` is not a privacy boundary: the worktree scanner deliberately examines ignored build-style directories.

The scanner reports only the rule and path, never the matched value. Unreadable inputs and inventory failures fail closed. Release checks scan the worktree, Git index, and reachable history. CI and demonstrations must run without production credentials.

Private compatibility snapshots belong in access-controlled private infrastructure with bounded retention. Public fixtures may preserve structural edge cases only after an allowlisted transformation and a successful privacy scan.
