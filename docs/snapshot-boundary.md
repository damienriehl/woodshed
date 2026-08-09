# Private snapshot boundary

Woodshed accepts only versioned neutral application snapshots. The public importer has no source-system client or credentials. A snapshot is a full, consistent-cut export addressed to one destination community, expires on a bounded schedule, and travels in an authenticated encrypted envelope whose data key is wrapped to a verified recipient.

Imports are staged outside active community state. Validation covers envelope authentication, expiry, destination, schema/profile, full-snapshot semantics, source watermark ordering, and parent references. One commit-marker operation makes staged records active; failures before it are invisible and retryable. Duplicate snapshot IDs are idempotent and older watermarks fail closed.

`@woodshed/privacy-fixtures` retains only allowlisted structural relationships and synthetic identifiers. Derived fixtures must pass the repository privacy workflow before review. Unknown source fields are reported by the private compatibility report, never silently copied into public artifacts.
