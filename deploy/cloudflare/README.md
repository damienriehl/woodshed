# Cloudflare Worker configuration

> Status: experimental adapter slice, not a complete Woodshed deployment. It currently proves D1-backed discovery, public accountless sessions, ranked ballot read/write, proposals, logout, live queue commands, and Durable Object authority handoff/recovery. It does not yet expose invite exchange, account claiming, draft setlists, staffing, or rehearsal APIs. Use the Node/SQLite runtime for the complete implemented application surface.

Do not replace tracked values in `wrangler.jsonc` with account-specific values. The checked-in `staging` environment is a non-deployable contract: deployment tooling must validate the private inventory and generate its effective configuration beneath the ignored `.cloudflare-staging/` directory. Account IDs, database IDs, real origins, credentials, and unredacted command output stay outside the public repository.

The private inventory must select the literal `staging` environment, bind a Worker whose safe name contains `staging`, provide the expected full source commit, and enumerate forbidden production identities. Validation fails closed for a dirty worktree, an unexpected or abbreviated commit, unknown fields, placeholder values, unsafe or Hootenanny-shaped targets, and any overlap with the forbidden inventory. Diagnostic summaries name only configured field classes; they never print configured values.

`LIVE_COMMAND_SECRET` is a server-held root used to derive a separate command credential for each community, event, and device. The authenticated authority acquire and handoff-confirm responses return only that device-scoped credential.

The Worker expects these bindings:

- `DB`: D1 database
- `LIVE_COORDINATOR`: `LiveCoordinator` Durable Object namespace
- `APP_ORIGIN`: exact browser origin allowed to mutate state
- `LIVE_COMMAND_SECRET`: secret-store binding with at least 32 random bytes

Deploy schema before code. Do not route production traffic until the missing endpoint/session contract is implemented and the migration, Worker health, ballot, live-command, and authority-handoff smoke checks pass against the target environment.

All Cloudflare commands must use the repository-local, exactly pinned Wrangler binary with both the checked-in config and the explicit staging environment. This mutation-free check demonstrates that selection without reading an ambient global Wrangler installation:

```sh
npm run cloudflare:staging:version
```

It does not authenticate, inspect an account, or mutate Cloudflare. There is intentionally no production environment or promotion command in this contract.

## Local deployment rehearsal

Run the bundled smoke gate before configuring or mutating a Cloudflare account:

```sh
npm run smoke:cloudflare
```

The gate bundles the actual Worker entry point and runs it with genuine local workerd D1 and Durable Object bindings through pinned Miniflare. It applies the ordered D1 migration chain before seeding synthetic events, then exercises public join, event-scoped cookies, context, ballot persistence, proposals, logout, and authority acquisition. It also verifies that a quota query uses migration 008's index and that the event trigger seeds choice configuration.

This local gate does not deploy, create D1 databases, write secrets, change DNS, or route traffic. A real staging rehearsal still requires reviewed target-specific values for `database_id`, `APP_ORIGIN`, and `LIVE_COMMAND_SECRET`; apply migrations before Worker code and record rollback evidence before changing an alias.

### Deployed synthetic acceptance

The programmatic `runDeployedAcceptance` boundary requires an immutable deployed journal. It journals the deterministic synthetic fixture graph before the first write, then exercises the exact HTTPS origin through participant, security-denial, authority, live-command, and logout checks. Public evidence contains statuses, counts, and revisions only. A passing smoke remains `quarantined`; only whole-stack teardown may mark cleanup complete.
