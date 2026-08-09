# Live performance and offline authority

Woodshed’s live queue is designed for unreliable venue connectivity without allowing an offline browser to become a second stage authority.

## Authority and handoff

Exactly one device holds a server-confirmed authority epoch for an event. Initial acquisition, handoff confirmation, cancellation, lost-device recovery, and credential rotation are coordinator operations. A requested handoff remains visibly pending; the receiving device cannot direct the stage until the server confirms a newer epoch. Revocation increments the epoch, making captured commands from the lost device superseded.

Every live command binds the community, event, actor, device installation, authority epoch, base revision, operation ID, issuance, expiry, action, entry, and canonical payload under device-scoped authentication. The server’s clock decides validity. Idempotent replay returns the original receipt; altered replay, expired commands, cross-event commands, and superseded authority are rejected. A harmless stale request to add an unseen queue entry can only become a visible suggestion. It never overwrites the authoritative queue.

Queue entries move through `suggested`, `planned`, `queued`, `current`, `performed`, `skipped`, `deferred`, and `restored` via explicit legal transitions. Completed performances append immutable history. Audit records contain action metadata and linkage, not raw command payloads.

## Offline device behavior

The app shell is service-worker cached. Operations and checkpoints use IndexedDB; secrets are never placed in browser key-value storage. Startup, online, focus, and manual actions trigger foreground synchronization. Background Sync is an optional browser enhancement, not a correctness dependency.

The interface labels offline leases, delayed changes, conflicts, rejections, last-confirmed freshness, and handoff state. Event data is purged on logout, event close, revocation, or expiry. “Clear this device” removes all offline records. A `BroadcastChannel` seam coordinates tabs. Bounded outboxes fail explicitly on quota pressure; service-worker upgrades replace old shell caches without rewriting domain data.

SQLite provides a durable Node single-writer coordinator. Cloudflare deployments use the Durable Object-compatible state seam for authority and D1 for queue/history persistence. Neither adapter changes the command or transition contract.

## Failure matrix

- Two organizers offline: only the confirmed epoch may replay authority commands; the other device’s work is rejected or offered as a suggestion where safe.
- Partition during handoff: the original device remains authoritative until confirmation; cancel is safe.
- Duplicate perform: idempotent same-operation replay returns the receipt; another perform transition is invalid.
- Event closes before replay: close/revocation purges the event outbox and invalidates its lease.
- Repeated reconnect: operation receipts prevent duplicate effects.
- No Background Sync, denied persistence, or eviction: foreground sync and explicit freshness remain the supported path; the UI must not claim a save it cannot prove.

## Visual reference

The checked-in references use invented event, song, and device state. They preserve the stage-lead hierarchy, current-song focus, queue/suggestion separation, freshness reporting, and visibly pending handoff across desktop and narrow mobile layouts.

- [Desktop stage-lead reference](visual-reference/live-stage-lead-desktop.png)
- [Mobile stage-lead reference](visual-reference/live-stage-lead-mobile.png)
