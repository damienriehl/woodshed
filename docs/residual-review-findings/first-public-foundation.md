# First public foundation: known residuals

These findings remain after the full implementation and independent review passes. They are explicit release gates, not implicit promises.

## Cloudflare application parity

The Cloudflare Worker currently supports discovery, authenticated ballot replacement, live commands, and stage-authority transitions. It does not issue participant sessions and does not expose proposals, draft setlists, staffing, or rehearsal routes. Implement one shared endpoint/authentication contract across Node and Worker, then run a destination-parity suite before describing Cloudflare as a complete deployment.

## Asynchronous D1 rehearsal application

The D1 coordination repository implements the explicit asynchronous persistence port and passes atomicity/conformance tests. The current `CoordinationService` is synchronous for the Node/SQLite runtime and cannot consume that port. Add an asynchronous application service or make the application contract consistently asynchronous before enabling rehearsal coordination on Cloudflare.

## Browser and deployment evidence

- Add real IndexedDB quota/abort/eviction and cross-tab purge tests.
- Add service-worker upgrade and offline-navigation race tests.
- Run a bundled Wrangler/workerd smoke test for the Worker and Durable Object.
- Start the Docker deployment and prove healthy/unhealthy container transitions.
- Supply real backup and isolated restore evidence before any production cutover.

## Manual graduation gates

Publication or capability cutover still requires a named owner and independent approver, representative organizer validation, frozen release/config/schema fingerprints, read-first shadow reconciliation, final watermarks, exactly-one-writer evidence, a proven rollback path, and the documented +5m/+1h/+4h/+24h observations. Hootenanny remains authoritative until each capability passes those gates independently.
