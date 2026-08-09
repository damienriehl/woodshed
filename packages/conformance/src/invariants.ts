export type InvariantViolation = { invariant: string; count: number };
type Queryable = { prepare(sql: string): { get(): unknown } };

const QUERIES = {
  "one-current-ballot-per-participation-event": `SELECT count(*) AS value FROM (SELECT event_id, participation_id FROM ballots GROUP BY event_id, participation_id HAVING count(*) > 1)`,
  "current-ballot-has-version": `SELECT count(*) AS value FROM ballots b LEFT JOIN ballot_versions v ON v.ballot_id = b.id AND v.revision = b.current_revision WHERE b.current_revision > 0 AND v.ballot_id IS NULL`,
  "mutation-has-audit-and-receipt": `SELECT count(*) AS value FROM ballot_versions v LEFT JOIN audit_events a ON a.operation_id = v.operation_id AND a.community_id = v.community_id AND a.event_id = v.event_id AND a.aggregate_revision = v.revision LEFT JOIN idempotency_receipts r ON r.audit_event_id = a.id AND r.operation_id = v.operation_id AND r.community_id = v.community_id WHERE a.id IS NULL OR r.operation_id IS NULL`,
  "community-isolation": `SELECT count(*) AS value FROM ballots b JOIN guest_participations p ON p.id = b.participation_id JOIN events e ON e.id = b.event_id WHERE b.community_id <> p.community_id OR b.community_id <> e.community_id`,
  "non-broadening-consent": `SELECT count(*) AS value FROM guest_participations WHERE consent_scope <> 'event'`,
} as const;

export function queryInvariants(database: Queryable): InvariantViolation[] {
  return Object.entries(QUERIES).flatMap(([invariant, sql]) => {
    const count = Number((database.prepare(sql).get() as { value: number }).value);
    return count === 0 ? [] : [{ invariant, count }];
  });
}

export { QUERIES as INVARIANT_CATALOG };
