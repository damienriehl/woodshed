# Cutover and rollback operations

The cutover owner controls the journal and routing operation. An independent approver verifies frozen inventory, restore proof, privacy provenance, and the exact commands. The on-call owner watches the declared thresholds and records evidence IDs; dashboards and logs must not contain ballot contents or private snapshot values.

## Before any write

1. Write the ownership journal with run ID, capability, release SHA, and `pre-write` phase.
2. Parse the complete inventory and reject missing/unknown entries.
3. Verify the immutable release origin matches the exact marker before changing an alias.
4. Run read-first UAT, baseline queries, restore proof, and shadow reconciliation.
5. Keep the new writer inert until command drain and legacy freeze are independently observed.

Credential sources have an explicit precedence: process-scoped secret injection, platform secret store, then no credential. Environment files and interactive CLI sessions are not accepted release evidence. Production verification writes are prohibited; observe existing traffic after routing.

## Failure and teardown

Record the current phase (`pre-write`, `schema-expanded`, `reader-live`, `writer-inert`, `routed`, or `observing`) before each action. Teardown is re-entrant and may remove only resources whose ownership journal matches both run and release identity. A partial deploy never advances authority. After a Woodshed write, do not run cutback commands unless journal replay or a bounded freeze/snapshot proof exists; otherwise declare forward-fix.

Retire legacy only after the +24h check, publication approval, capability-specific retirement approval, archive/restore proof, and confirmation that no other capability still depends on that legacy surface.
