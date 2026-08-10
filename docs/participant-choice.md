# Participant choice preview

The first vertical slice keeps communities as the durable home and events as distinct contexts. Public, unlisted, and private describe discovery; open and invite-only describe eligibility. They are intentionally independent.

Invite capabilities are single-use, short-lived, stored only as hashes, exchanged for secure scoped sessions, and removed from browser URLs by the exchange redirect. Open-public participation is lower assurance and is labeled as such. Writes require both a same-origin request and CSRF signal. Participant ballots are whole-document conditional replacements with idempotent operation IDs. General aggregates redact cohorts smaller than three and do not expose individual rankings.

Open joins are bounded to 10,000 active participations per event by default. Deployments may set a smaller application-level limit through `ChoiceService` configuration; exhaustion fails explicitly with HTTP 429. This is a deployment-agnostic resource bound, not a substitute for an edge rate limiter or a claim that forwarded client-IP headers are trustworthy.

New events use ranked choice. Imported flat ballots retain their original interpretation. Candidate order is deterministic per participant; songs added later append without disturbing the existing order. Proposal policy is organizer-configurable between immediate eligibility and editorial review, with per-participant quotas and replay-safe operation identifiers.

`draft-setlist/v1` separates participant demand from feasibility, distinguishes unknown feasibility from zero, records its version, weights, seed, and input fingerprint, and preserves organizer override reasons.

Run `npm run dev` to start the Node/SQLite API with synthetic demo data and the responsive React preview together. The browser reuses an existing scoped guest session before creating a new open-public participation, so ballot revisions and rankings survive reload. Rehearsal and live controls remain explicitly synthetic until their browser/API slices ship.

## Visual reference

The checked-in references use invented community, event, and song data. They preserve the intended hierarchy for later UI work: adjacent events remain compact, while the selected event and selected ballot item expand into clearly labeled attribute regions.

- [Desktop participant-choice reference](visual-reference/participant-choice-desktop.png)
- [Mobile participant-choice reference](visual-reference/participant-choice-mobile.png)
- [Desktop API-backed onboarding reference](visual-reference/api-backed-onboarding-desktop.png)
- [Mobile API-backed onboarding reference](visual-reference/api-backed-onboarding-mobile.png)
