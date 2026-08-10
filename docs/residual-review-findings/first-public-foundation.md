# First public foundation: known residuals

These findings remain after the full implementation and independent review passes. They are explicit release gates, not implicit promises.

## Cloudflare application parity

The Cloudflare Worker now supports discovery, public accountless sessions, ranked ballot read/write, proposals, logout, live commands, and stage-authority transitions. It still does not expose invite exchange, account claiming, draft setlists, staffing, or rehearsal routes. Complete those shared endpoint contracts before describing Cloudflare as a complete deployment.

## Asynchronous D1 rehearsal application

The D1 coordination repository implements the explicit asynchronous persistence port and passes atomicity/conformance tests. The current `CoordinationService` is synchronous for the Node/SQLite runtime and cannot consume that port. Add an asynchronous application service or make the application contract consistently asynchronous before enabling rehearsal coordination on Cloudflare.

## Browser and deployment evidence

- Add real IndexedDB quota/abort/eviction and cross-tab purge tests.
- Add service-worker upgrade and offline-navigation race tests.
- Run `npm run smoke:cloudflare` locally, then repeat the migration-first smoke against a configured staging Worker and Durable Object before routing traffic.
- Start the Docker deployment and prove healthy/unhealthy container transitions.
- Supply real backup and isolated restore evidence before any production cutover.

## Manual graduation gates

Publication or capability cutover still requires a named owner and independent approver, representative organizer validation, frozen release/config/schema fingerprints, read-first shadow reconciliation, final watermarks, exactly-one-writer evidence, a proven rollback path, and the documented +5m/+1h/+4h/+24h observations. Hootenanny remains authoritative until each capability passes those gates independently.
