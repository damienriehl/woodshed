# Cloudflare Worker configuration

> Status: experimental adapter slice, not a complete Woodshed deployment. It currently proves D1-backed discovery, public accountless sessions, ranked ballot read/write, proposals, logout, live queue commands, and Durable Object authority handoff/recovery. It does not yet expose invite exchange, account claiming, draft setlists, staffing, or rehearsal APIs. Use the Node/SQLite runtime for the complete implemented application surface.

Before deploying, replace the D1 database identifiers and `APP_ORIGIN` placeholder in `wrangler.jsonc`, apply every migration in `migrations/d1`, and provision `LIVE_COMMAND_SECRET` through the platform secret store. Never place that secret in `wrangler.jsonc`, source control, command output, or a client bundle.

`LIVE_COMMAND_SECRET` is a server-held root used to derive a separate command credential for each community, event, and device. The authenticated authority acquire and handoff-confirm responses return only that device-scoped credential.

The Worker expects these bindings:

- `DB`: D1 database
- `LIVE_COORDINATOR`: `LiveCoordinator` Durable Object namespace
- `APP_ORIGIN`: exact browser origin allowed to mutate state
- `LIVE_COMMAND_SECRET`: secret-store binding with at least 32 random bytes

Deploy schema before code. Do not route production traffic until the missing endpoint/session contract is implemented and the migration, Worker health, ballot, live-command, and authority-handoff smoke checks pass against the target environment.

## Local deployment rehearsal

Run the bundled smoke gate before configuring or mutating a Cloudflare account:

```sh
npm run smoke:cloudflare
```

The gate bundles the actual Worker entry point and runs it with genuine local workerd D1 and Durable Object bindings through pinned Miniflare. It applies the ordered D1 migration chain before seeding synthetic events, then exercises public join, event-scoped cookies, context, ballot persistence, proposals, logout, and authority acquisition. It also verifies that a quota query uses migration 008's index and that the event trigger seeds choice configuration.

This local gate does not deploy, create D1 databases, write secrets, change DNS, or route traffic. A real staging rehearsal still requires reviewed target-specific values for `database_id`, `APP_ORIGIN`, and `LIVE_COMMAND_SECRET`; apply migrations before Worker code and record rollback evidence before changing an alias.
