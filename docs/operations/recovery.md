# Recovery and upgrade policy

All destinations target a 24-hour RPO. Node/SQLite and guided community cloud target a four-hour RTO; Cloudflare targets two hours. Backups are encrypted daily, retained for 30 days, held offsite from the primary data store, and use destination-controlled key custody. Operators must verify backup age continuously and perform a clean-destination restore drill at least every 14 days.

Upgrades use expand, resumable backfill, compatibility, enforcement, then contract phases. Migration identifiers and checksums are immutable. The upgrade dry run blocks unsupported binaries or archives and blocks destructive contract steps until compatibility retirement and rollback evidence exist. A destination is degraded when its backup, restore-drill, database, key-custody, or rollback evidence gate fails.

Archive creation never uses a plaintext temporary file. Each archive has a random data-encryption key, wrapped for the destination by a separate key-custody boundary. Download authorization is short-lived, actor-bound, audited, and independently revocable. Expiry removes the wrapped payload and is also authenticated cryptographically inside the envelope.
