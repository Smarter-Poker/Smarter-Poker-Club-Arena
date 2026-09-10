# Diamond Phase 6 Shared Cash Integration

Status: Implemented In The Phase 6 Worktree; Production Publication Is Not Complete.

## What Changed

The existing Club Arena buy-in, accepted-hand, occupancy cash-out and shared table UI now have an authoritative Diamond branch. Seat funding reserves existing Diamond custody and binds the database-stamped seat generation. The accepted-hand transaction retains the shared lease, history, time-bank, projection and immutable replay protocol while moving whole Diamond custody balances and consuming only actual purchased-lot losses. Cash-out releases the settled balance, including zero, without a fabricated wallet journal.

The engine refuses unsupported configurations and deductions. Chip add-ons, continuity, promo, jackpots, mission events and horse funding do not process Diamond games. Pending leave keeps the shared exact-occupancy path. Admission and engine validation agree on whole monetary table settings and the shared running status.

The client uses the shared table route and immutable buy-in recovery door, reads Diamond available balances, carries the actual arena asset through result/history views and recovers a deferred result from an authenticated exact-occupancy Diamond receipt. Unknown history assets do not enter monetary totals. No new dealer or wallet writer was introduced.

## Database Changes Awaiting Production Application

Apply these forward migrations once, in order, after checking current source prerequisites:

1. `20260910022036_diamond_cash_custody_settles_exact_seat_generations.sql`
2. `20260910023541_diamond_cash_admission_binds_existing_purchase_receipts.sql`
3. `20260910030442_diamond_accepted_hands_retain_history_without_chip_obligatio.sql`

The first adds seat identity, consumed purchase-lot holds and append-only hand receipts, and updates custody settlement/release. The second connects the existing buy-in/cash-out doors, enforces seat/custody consistency, adds the default-false admission setting and authenticated read-only access/result responses. The third connects Diamond acceptance and projection to the existing protocol without chip or hierarchy obligations.

These migrations change production financial functions. Automatic approval review rejected the first application because it requires approval of these exact Phase 6 production changes rather than the earlier general custody authorization. No alternate write path was attempted and none of these migrations is claimed as applied. The production preflight found no custody rows; current settlement/release definitions matched the inspected prerequisites exactly.

## Verification And Remaining Gates

Isolated admission certification passed 74 assertions, including its 38 custody prerequisites. It covers concurrent authenticated purchase replay, revoked/wrong-user sessions, maintenance, fractional table configuration refusal before funding, final occupancy binding, failure rollback, partial-pot conservation, exact cash-out replay, and authenticated own-receipt recovery.

The separate accepted-hand database passed 48 assertions, including 27 accepted-protocol checks and 21 inherited custody bootstrap checks. These cover concurrent replay, exact lease/generation fencing, custody/history/time-bank rollback, projection rollback/recovery, canonical history/index retention and refusal of chip, mission and special-award obligations. Counts from separate suites overlap and must not be added as distinct assertions.

Engine/client test and build evidence is finalized below after the integrated checks. The earlier foundation PR 4088 CI 34430999353 failed at the unapplied-migration gate. Its client/server checks passed; that does not turn the failed gate into success. Do not rerun until the actual migration and schema evidence have been updated.

No public funded game was enabled. `cash_games_enabled` defaults false. The existing accounting release condition is unchanged. Final production migration application, required CI, normal merge/publication, actual frontend/engine ancestry and permitted live acceptance remain open. Phase 6 is not declared complete and Phase 7 is not declared ready.

## Integrated Local Evidence

- Client funding/access/financial-event cases: 22 passed. History/result cases: 85 passed. Existing chip-continuity and unknown-balance compatibility cases: 17 passed.
- Initial focused engine cases: 172 passed without skips. Latest integrated run: 59 passed across Diamond accepted-hand pipeline, Diamond config, horse funding boundary, restart behavior and occupancy leave behavior. Eight cases overlap the earlier run; do not add these runs as distinct totals.
- Final server TypeScript passed. The client production build passed TypeScript, bundling and media/font processing. Its provenance correctly warned that the development branch was behind main and dirty, so this local artifact is not publication evidence. Main integration and normal pipeline checks follow.
- No generated production artifact was uploaded manually. Git operations target this exact isolated worktree; the shared repository's bare setting was not changed.

## Main Integration Proof

The completed implementation is commit `26c006880c`, consolidated into the existing Phase 6 foundation branch for PR 4088. Latest main and the normal autopilot branch update merged without conflicts as `dad35dfeeb`. The subsequent complete client build passed on that clean source, with build provenance `behind-main=0`. Final server TypeScript passed after integration. The 14 merge-specific next-hand, tournament-blind and Diamond accepted-hand cases passed. The earlier dirty development build was not used as release proof.

Production application remains blocked by the automatic approval review described above. The code push and subsequent CI must preserve that failed migration gate until application is authorized and verified. No engine/container/tag/host checkout changes or Stage-B tournament DDL were performed by this Diamond task.

## Required Push Regression Repairs

The first full integration push was refused by the normal regression hook; it was not published. The engine table SELECT now preserves the existing contract parser prefix without removing any loaded field, and its 48 focused contract cases passed. The shared client cash-out door no longer performs a second occupancy read before submitting leave. Instead, SeatLeaveIntent returns the original occupancy already verified against the engine protocol, and both normal and forced departure summaries retain it. The chip-only buy-in floor RPC and error reporting remain explicit, and callback fixtures supply the authoritative chip identity required by the new funding boundary.

The repaired client run passed 72 cases across cashBuyInCallbackRecovery (19), SeatLeaveIntent (18), seatFirstAuditRound7 (15), theDoorIsNeverLocked (15), and diamondTableFunding (5). Exact receipt cases include deferred leave, response loss followed by reseating, and confirmed zero cash-out. The removed helper's test was replaced by receipt-boundary coverage, rather than retaining a redundant network query. Re-read and diff whitespace checks passed. Integrated TypeScript/build and the required normal push checks follow; these focused results do not claim publication.

The final lobby wiring adds a registered, per-instance, club-filtered database subscription. Remote table updates, reconnection and visibility/focus reconciliation refresh the authoritative inventory, coalescing event bursts. No interval polling was added. Three rendered-component cases passed for remote occupancy updates, reconnection/visibility and cleanup. The shared hook retains subscription ownership and recovery.

## Final Repair Integration

The leave-flow, engine SELECT and cross-device lobby repairs are committed as `5290cac1c9`. Current main's lobby inventory repair merged as `71f57c9585`, preserving the other release's shared lobby behavior. `npm run build` completed on this clean source with `behind-main=0`, and server TypeScript passed. Media processing reported 480 optimized and zero failures. No manual upload or engine restart was performed.

A fresh read-only production prerequisite check found that the shared 12-argument accepted-hand wrapper now uses the table-aware settlement lane. Its source fingerprint differs from the earlier fixture. The Phase 6 migration must preserve that current lane behavior before application; simply changing the expected fingerprint is insufficient. The other inspected migration prerequisites still match. Controlled multi-user play connected through the actual engine and local database is being completed separately from the earlier component checks. Production application and final live acceptance remain open.

## Connected Isolated Play Certification

`python3 tests/sql/run-diamond-controlled-play.py` passed with exit code zero using only the fixed local socket and dedicated `poker_diamond_phase6_play_test` database. Two authenticated immutable purchases reserved 100 Diamonds each. The actual shared HandController performed legal all-in actions and produced stacks `[200, 0]`. Those exact output facts entered the real twelve-argument SQL accepted-hand transaction, projected both players' histories, then used the actual occupancy cash-out functions.

The final wallets were `[1100, 900]`, preserving the initial 2000 Diamonds, with zero remaining custody and no live seats. Purchase, accepted-hand and cash-out response-loss retries did not duplicate funding, settlement or payment. The zero-balance player's authenticated own-receipt returned zero. No chip membership or mint writes occurred, and Diamond movement journals netted to zero. Existing side-pot, tie, disconnect and restart cases are reused from the focused suites; this connected case does not repeat them. The driver mocks only external alert/report delivery, not gameplay, database acceptance or custody writers.

This closes the connected local play evidence gap. It is not a browser/WebSocket transport certificate or proof of production application and publication. Public `cash_games_enabled` remains false in production; it was enabled only inside this isolated fixture.

The settlement-lane compatibility repair is now complete: the pending migration preserves the inspected production helper, its exact body preflight, and current private execution grants. The accepted-hand runner passed 50 assertions (the previous 48 plus two actual lock-ownership checks). See [the settlement-lane evidence](2026-09-10-diamond-phase-6-settlement-lane-compatibility.md). The connected-play run above used these updated prerequisites. This closes the local source-compatibility gate while production application remains blocked.

The normal integration push then exposed four exact-return expectations in TableService.cashoutReceipt that had not included the newly returned verified occupancy ID. All four now assert that identity while retaining their original amounts, deferred state, logging-failure and tournament protections. All 18 TableService receipt cases passed. No runtime change was needed. The normal push hook is rerun because it is a required gate, not an optional duplicate test pass.
