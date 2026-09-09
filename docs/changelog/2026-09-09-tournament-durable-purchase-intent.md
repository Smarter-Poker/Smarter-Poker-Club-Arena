# Tournament Durable Purchase Intent

Rebuy and add-on retries previously repeated eligibility reads and recomputed the quote and blind level before reaching the retained database receipt. A committed purchase followed by a lost response could therefore become unretrievable when the level or purchase window changed. Callers without a prompt token also entered the legacy fallback.

TournamentService now persists the complete original RPC request before submission. A Web Lock serializes same-origin tabs; session storage preserves an older tab's unresolved request when shared storage advances. A retry submits the same identity, amount, chips and level before fresh eligibility checks. Distinct later purchases receive distinct tokens. Only validated database receipts acknowledge a purchase. Storage acknowledgement failure preserves the request for replay.

Both tournament modal callbacks now pass the exact confirmed stack, including zero. Neither substitutes configured chips or an estimated stack. The service return type requires a confirmed numeric stack.

## Verification

110 focused tests across four files and TypeScript passed locally. These cover service-level rebuy, reentry and add-on retries after eligibility changes; competing independently loaded modules; reloads; original payload retention; old-tab isolation; malformed saved state; storage failure; and modal zero-stack callbacks. Browser-native and production adoption acceptance remain pending.

PR3991 CI34389715780 shard4 failed an unrelated asynchronous wallet assertion: the test observed the RPC invocation before the response updated the displayed balance. It now awaits the same exact 70,000.00 result; no production wallet code or expected balance changed. Shard3 log reported all317 files passed.

The initial local production build compiled, but provenance reported newer main commits. A normal main merge and rebuilt release evidence are required before publication. No claim of phase completion, deployed adoption, or production transaction testing is made.

## Remaining Phase Scope

All12 CA-03 controls remain open for complete acceptance. Registration, funded prize and bounty commitments, payouts, guarantees, Spin treasury allocation, satellite tickets, cancellation, seating and all related UI paths still require the original programme's evidence. No runtime chip watcher, reconciler or compensating balance patch was added.
