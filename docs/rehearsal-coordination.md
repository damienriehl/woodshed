# Arrangement and rehearsal coordination

Woodshed separates three facts that are easy to conflate: an event song decision records the immutable arrangement at a revision, a performance assignment records who has been asked and confirmed for one part, and readiness records the performer’s current preparation. A material key, notes, rights, person, or part change creates a new decision version and invalidates only readiness tied to the affected parts.

Volunteer interest never assigns a person. The assignment lifecycle is `volunteered → offered → accepted → assigned`, with `declined`, `withdrawn`, and `substituted` terminal outcomes. Accepted backups are promoted deterministically when the primary withdraws, but Woodshed records that substitution rather than rewriting history.

Rehearsal candidates are stored as UTC instants plus an IANA timezone. This makes repeated or skipped local times around daylight-saving changes unambiguous. Availability ranking prioritizes required people, then other respondents, and uses stable instant and identifier tie-breakers. Organizers still choose, publish, update, or cancel the session. Attendance and readiness outcomes are auditable results of the rehearsal.

## Provider boundary

The core scheduling and agenda workflow requires no calendar or messaging provider. A provider connection grants only allowlisted scopes:

- `free-busy:read` reveals opaque busy windows, not calendar titles.
- `calendar-events:write` permits organizer-approved rehearsal publication.
- `notifications:send` permits categorized delivery to an opaque recipient reference.

Connections display their scopes and retention rule. Disconnecting revokes the adapter credential, rejects later callbacks, removes retained callback data, and marks unsent delivery records revoked. Sent delivery receipts retain only opaque references needed to prevent duplicate sends and follow the community audit-retention policy. Callback IDs and delivery IDs are idempotency keys; rate limiting leaves a retryable pending record and a repeated successful job does not resend.

The checked-in adapter is an in-memory test adapter. It contains no credentials and performs no network requests.

## Visual reference

These checked-in references use invented event, song, and performer data. They preserve the selected-arrangement hierarchy and the organizer’s staffing and scheduling workflow across desktop and narrow mobile layouts.

- [Desktop rehearsal-coordination reference](visual-reference/rehearsal-coordination-desktop.png)
- [Mobile rehearsal-coordination reference](visual-reference/rehearsal-coordination-mobile.png)
