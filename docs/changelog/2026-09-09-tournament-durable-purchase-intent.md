# Tournament Durable Purchase Intent

Rebuy and add-on retries previously repeated eligibility reads and recomputed the quote and blind level before reaching the retained database receipt. A committed purchase followed by a lost response could therefore become unretrievable when the level or purchase window changed. Callers without a prompt token also entered the legacy fallback.

TournamentService now persists the complete original RPC request before submission. A Web Lock serializes same-origin tabs; session storage preserves an older tab's unresolved request when shared storage advances. A retry submits the same identity, amount, chips and level before fresh eligibility checks. Distinct later purchases receive distinct tokens. Only validated database receipts acknowledge a purchase. Storage acknowledgement failure preserves the request for replay.

Both tournament modal callbacks now pass the exact confirmed stack, including zero. Neither substitutes configured chips or an estimated stack. The service return type requires a confirmed numeric stack.

## Verification

110 focused tests across four files and TypeScript passed locally. These cover service-level rebuy, reentry and add-on retries after eligibility changes; competing independently loaded modules; reloads; original payload retention; old-tab isolation; malformed saved state; storage failure; and modal zero-stack callbacks. Six isolated native Chromium scenarios now pass using real Web Locks and storage across two tabs and reloads for rebuy, reentry and add-on. The fixture never calls production transaction endpoints. Production adoption remains pending.

PR3991 CI34389715780 shard4 failed an unrelated asynchronous wallet assertion: the test observed the RPC invocation before the response updated the displayed balance. It now awaits the same exact 70,000.00 result; no production wallet code or expected balance changed. Shard3 log reported all317 files passed.

The initial local production build compiled, but provenance reported newer main commits. Main was merged normally as 4b163e08. Integrated TypeScript and the production build pass with behind-main=0. Automatic approval review rejected the integrated build with Sentry upload; the successful local build omitted SENTRY_AUTH_TOKEN only from its child environment, leaving repository release configuration intact. This local artifact is not publication proof. No claim of phase completion, deployed adoption, or production transaction testing is made.

## Remaining Phase Scope

All12 CA-03 controls remain open for complete acceptance. Registration, funded prize and bounty commitments, payouts, guarantees, Spin treasury allocation, satellite tickets, cancellation, seating and all related UI paths still require the original programme's evidence. No runtime chip watcher, reconciler or compensating balance patch was added.

The expanded focused run including the wallet assertion passed131 tests across five files. The first full-client run passed17690 tests with7 repository-scan timeouts at the unchanged5000ms limit. A four-worker run is recorded separately; no timeout or assertion was weakened.

The four-worker full-client run completed with17682 passed and15 repository-scan timeouts across14 files. All14 affected files then passed unchanged with one worker. This is isolated failure-resolution evidence, not a claim that either full-suite run was green. Logs remain in /tmp/chip-conservation-evidence/phase-three-integrated-client-four-workers.log and phase-three-scan-failures-isolated.log.

Publication of this batch has not been attempted after the Sentry export rejection. The initial purchase-confirmation PR3991 remains open; the new local branch commits await an authorized release path. No hooks were bypassed.
