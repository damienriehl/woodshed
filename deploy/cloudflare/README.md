# Cloudflare Worker configuration

Before deploying, replace the D1 database identifiers and `APP_ORIGIN` placeholder in `wrangler.jsonc`, apply every migration in `migrations/d1`, and provision `LIVE_COMMAND_SECRET` through the platform secret store. Never place that secret in `wrangler.jsonc`, source control, command output, or a client bundle.

`LIVE_COMMAND_SECRET` is a server-held root used to derive a separate command credential for each community, event, and device. The authenticated authority acquire and handoff-confirm responses return only that device-scoped credential.

The Worker expects these bindings:

- `DB`: D1 database
- `LIVE_COORDINATOR`: `LiveCoordinator` Durable Object namespace
- `APP_ORIGIN`: exact browser origin allowed to mutate state
- `LIVE_COMMAND_SECRET`: secret-store binding with at least 32 random bytes

Deploy schema before code. Do not route production traffic until the migration, Worker health, ballot, live-command, and authority-handoff smoke checks pass against the target environment.
