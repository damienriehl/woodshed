# Read-first cutover UAT

This UAT is intentionally safe before writes. `npm run test:uat` exercises all four capability authorities with synthetic public records, failed and partial deployment gates, refresh restrictions, shadow mismatches, writer overlap, and rollback choices.

For every capability, create a frozen cutover artifact containing:

- a distinct owner and approver;
- immutable release SHA, exact release marker, configuration fingerprint, schema version, and privacy scan provenance;
- named baseline queries and a result fingerprint (never result values);
- backup ID and a successful clean-destination restore proof;
- deploy order, immutable origin, later alias, routing flag, and exact pinned CLI version;
- observations at +5m, +1h, +4h, and +24h with evidence IDs;
- literal reviewed rollback commands and numeric error/mismatch thresholds;
- command-drain, writer-freeze, reconciliation, and exactly-one-writer approvals.

Inventory parsing fails closed: missing, unknown, malformed, or ambiguous fields stop graduation. A partially deployed reader is safe only while the Woodshed writer remains inert. Publication approval and legacy-retirement approval are separate gates.

## Recommendation evidence

The validator persists algorithm version, configuration fingerprint, seed, input fingerprint, override-burden samples, and comprehension results. Thresholds remain those predeclared in `recommendation-baseline.md`: 70% top-five acceptance, at most 25% median override burden, 80% explanation comprehension, deterministic replay, and a minimum aggregate cohort of three. Structural synthetic validation proves the runner; representative organizer testing is still required before production graduation.
