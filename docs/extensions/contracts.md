# Extension and provider contracts

Extensions receive narrow, versioned capabilities. The host re-runs core authorization; an extension declaration cannot grant itself a capability. Content operations additionally require rights approval, and private-content access is disabled by default until legal terms, privacy review, retention, and access expiry are approved.

Provider connections display their granted scopes. Disconnect revokes the credential and deletes provider-derived caches under the provider retention policy. Providers cannot receive ballots, contact details, or private profiles merely because they can send notifications or read calendar free/busy state.

Themes and event templates may customize presentation and defaults. They cannot replace authorization, consent, archive validation, audit, or coordinator authority logic.
