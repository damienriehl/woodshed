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

The programmatic `runDeployedAcceptance` boundary requires an immutable deployed journal. It journals the deterministic synthetic fixture graph before the first write, then exercises the exact HTTPS origin through participant, security-denial, authority, live-command, and logout checks. Public evidence contains statuses, counts, and revisions only. Passing acceptance records `verified`; the live driver's `verify` operation then quarantines the origin before returning. Only whole-stack teardown may mark cleanup complete.
### Recovery and teardown

Recovery treats Worker code, D1, and Durable Object state as separate domains. Worker rollback is allowed only to a verified version with the same legacy Durable Object lifecycle and compatible D1 schema, Durable Object value shape, bindings, and secrets. D1 Time Travel requires a quarantined, non-writable origin plus an unchanged exclusive-owner/last-write check and never claims to restore Durable Object state.

Teardown removes only the run journal identities, in dependency order, and proves route/hostname, credentials/secret, Worker/version, Durable Object namespace/state, D1, and any run-minted token absent. It never revokes the borrowed operator token. Durable Object deletion stays on the existing legacy migration-array mechanism with an explicit run-owned `deleted_classes` lifecycle tag. A corrupt journal, identity drift, or unexpected dependent authorizes no deletion. Retain the private journal through the +24-hour absence/audit check. See docs/operations/cloudflare-staging.md for the operator contract.

## Shared-account contract

The live driver rehearses in the owner's existing Cloudflare account. Worker and D1 API tokens are account-scoped, so a driver defect can reach an unrelated live resource. The non-bypassable mitigations are: `inventory.forbidden` acts as a target denylist; declared protected identities may be present but may not be targeted; undeclared production-, `prod`-, or Hootenanny-shaped Worker, D1, route, or origin inventory refuses preflight; created names remain staging-only; mutations require journal ownership; and identity is re-read immediately before every write. `forbidden.accountIds` contains only other accounts that staging must never touch, never the staging account, and may be empty when the token can see only the staging account.

Keep the closed-schema inventory and journal outside the repository. The first supported live origin is a run-owned `workers.dev` exposure. The driver always passes both a run-specific generated config and `--env staging` to the pinned local Wrangler binary; it never edits this tracked placeholder.

Secret values are accepted only through these environment variable names:

- `CLOUDFLARE_API_TOKEN`
- `LIVE_COMMAND_SECRET`
- `WOODSHED_STAGING_ORGANIZER_TOKEN`

The root live-command secret is sent to Wrangler over stdin, and the organizer token is used only in memory for fixture hashing and deployed HTTPS acceptance. Neither is accepted as a CLI argument. The operator-supplied `CLOUDFLARE_API_TOKEN` is borrowed: preflight records only that it is present and active, the journal does not own it, and teardown never revokes it. Only a token explicitly journaled as run-minted may be revoked. Wrangler receives an isolated generated home plus an explicit empty environment file, so ambient credentials and repository dotenv/dev-var files are outside the driver contract.

Run the sequence in [the staging runbook](../../docs/operations/cloudflare-staging.md). `plan` creates the private ownership journal with exclusive-create semantics before any Cloudflare mutation. `apply` creates D1, captures a Time Travel bookmark, applies the 11 migrations one at a time with postcondition snapshots, uploads the unexposed Worker/legacy SQLite Durable Object, installs the secret, and activates the exact attested origin. Authenticated preflight combines Wrangler account/D1/deployment/version/secret collectors with account-wide Worker-name, zone-route, Worker custom-domain, account-subdomain, and `workers.dev` exposure reads. The inventory origin must exactly match the authenticated account subdomain. `verify` runs deployed acceptance and proves quarantine before recording that phase. `teardown` removes the run-owned graph, preserves the borrowed operator token, deletes its generated config, and writes a redacted sibling evidence file next to the private journal. The first Durable Object lifecycle deployment is forward-fix-only; the packet never claims whole-stack rollback.
