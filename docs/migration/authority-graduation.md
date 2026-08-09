# Capability authority graduation

Migration is independent for `event`, `ballot`, `assignment`, and `live`. A successful ballot cutover never implies that live-show authority moved.

Each capability advances through `legacy-authoritative → shadow-imported → conformance-verified → Woodshed-authoritative → legacy-retired`. Skips are forbidden. Legacy is the sole writer through conformance. Woodshed becomes the sole writer only after the cutover watermark is captured, pending commands drain, the legacy writer freezes, shadow comparison passes, and routing changes. Refresh is allowed only while shadow-imported and must use a monotonic watermark. It is forbidden after conformance or any Woodshed write.

Rollback after a Woodshed write must name and prove exactly one model:

- replay an accepted-write journal into legacy before cutback;
- freeze both writers, take a bounded cutback snapshot, restore it, then route legacy;
- declare the change irreversible and forward-fix Woodshed without routing writes back.

The executable rules are in `@woodshed/graduation`. A routing flag is evidence, not authority by itself; the exactly-one-writer check is the gate.

## Graduation sequence

1. Import a read-only snapshot and record its watermark.
2. Run structural and semantic shadow comparison on synthetic data, then authorized private data outside the public repository.
3. Freeze release SHA, configuration fingerprint, schema version, privacy provenance, baseline query/result fingerprint, backup ID, and clean restore proof.
4. Deploy in order: schema expansion, reader, inert writer, routing. Verify the immutable release origin before changing an alias.
5. Complete read-first UAT. Drain commands, freeze legacy writes, reconcile at the final watermark, and prove exactly one writer.
6. Observe at +5 minutes, +1 hour, +4 hours, and +24 hours. Retirement is a separate approval after the full observation window.

Never place private snapshots, comparison values, credentials, or production output in this repository. Comparison evidence stores counts and hashed identifiers only.
