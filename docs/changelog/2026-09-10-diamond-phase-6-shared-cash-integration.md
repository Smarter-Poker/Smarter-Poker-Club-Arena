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
