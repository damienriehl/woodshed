# Participant choice preview

The first vertical slice keeps communities as the durable home and events as distinct contexts. Public, unlisted, and private describe discovery; open and invite-only describe eligibility. They are intentionally independent.

Invite capabilities are single-use, short-lived, stored only as hashes, exchanged for secure scoped sessions, and removed from browser URLs by the exchange redirect. Open-public participation is lower assurance and is labeled as such. Writes require both a same-origin request and CSRF signal. Participant ballots are whole-document conditional replacements with idempotent operation IDs. General aggregates redact cohorts smaller than three and do not expose individual rankings.

New events use ranked choice. Imported flat ballots retain their original interpretation. Candidate order is deterministic per participant; songs added later append without disturbing the existing order. Proposal policy is organizer-configurable between immediate eligibility and editorial review, with per-participant quotas and replay-safe operation identifiers.

`draft-setlist/v1` separates participant demand from feasibility, distinguishes unknown feasibility from zero, records its version, weights, seed, and input fingerprint, and preserves organizer override reasons.

Run the Node API with `npm run dev -w @woodshed/api-node` and the responsive React preview with `npm run dev`.

## Visual reference

The checked-in references use invented community, event, and song data. They preserve the intended hierarchy for later UI work: adjacent events remain compact, while the selected event and selected ballot item expand into clearly labeled attribute regions.

- [Desktop participant-choice reference](visual-reference/participant-choice-desktop.png)
- [Mobile participant-choice reference](visual-reference/participant-choice-mobile.png)
