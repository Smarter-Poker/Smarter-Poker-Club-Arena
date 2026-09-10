# Diamond Phase 6: Shared NLH Cash Game

Status: In Progress. No Public Funded Gameplay Release.

## Scope And Starting Point

Dan accepted the remaining World Hub lobby image as his work and authorized Phase 6. Phase 5 implementation, repairs, documentation and publication were verified; the image is excluded from this phase. This worktree started at `9eac7cab76d90bcaabefcdb932169d5f0ab60781` on `agent/codex-diamond-phase-6/feature/diamond-nlh-cash-game`.

Phase 6 must connect the existing shared NLH engine to Diamond-only seat funding, hand settlement and cash-out. The first certification is plain NLH with no deductions. This does not choose public stakes or rake, enable later variants, or waive the seven-clean-day public accounting gate.

## Implemented Engine Increment

- Hand configuration carries the authoritative loaded arena asset. Existing chip callers retain their default precision.
- Diamond hands reject fractional funding, blinds, antes and action amounts before mutation. External stack adjustments validate the complete batch before changing any stack.
- Shared winner evaluation and payout scaling allocate whole Diamonds; chip cash retains cents.
- A reproduced repeated-runout callback paid a completed all-in pot twice, changing stacks `[5, 8, 11]` into `[10, 16, 19]`. The shared completion guard now refuses late runout callbacks after completion. The regression test verifies unchanged stacks and exactly one completion event.
- No new dealer, evaluator, wallet, recovery worker or compensating writer was created.

## Verification

Local focused run: 47 tests passed across `DiamondCashHand.test.ts`, `aTournamentChipDoesNotDivide.law.test.ts` and `PotLimitShortBlinds.test.ts`. These cover a complete Diamond hand, rejected fractional raises, an odd tied pot, side pots, all-in runout replay, invalid funded amounts, atomic delta rejection, and unchanged chip betting. This is engine-only evidence; it is not database or production gameplay acceptance.

PR 4070 merged as 81e4c6daefa47f6b6883596f3b62d2d3498e195a. CI 34424324769 passed client/server, TypeScript, structural and SQL accounting gates; production build, browser, live-production and postdeploy jobs were skipped for this server increment. The normal local push passed 1,014 server assertions with 145 skipped. At September 10, 01:58:41 UTC production engine health identified b4c427a6e8474d796d29b682a9e153e03d78755d, with status/liveness/settlementStatus ok and zero blocked settlements. Git ancestry proves this running engine includes 81e4c6da. The normal maintenance cutover therefore adopted the engine increment; no forced restart was used. The frontend also includes the merge. This is adoption of the engine increment, not funded-game acceptance. No pending or skipped check is counted as passed.

## Local Implementation And Certification

- [x] Atomic Diamond seat acquisition: bind existing custody to exact seat occupancy without chip funding or chip ledger writes.
- [x] Accepted-hand settlement: retain the shared lease/generation/history protocol and update Diamond custody atomically, preserving purchase-lot provenance and exact replay.
- [x] Occupancy-bound cash-out: release the actual settled balance, including a busted zero balance, with strict rollback and durable retry receipts.
- [x] Wire the shared client buy-in/leave/history/result/wallet-refresh flow to the Diamond financial boundary.
- [x] Controlled multi-user certification against isolated PostgreSQL: full play/cash-out conservation, all-in, side pot, tie, disconnect, restart, pending leave and response-loss retry; assert no chip or hierarchy writes.
      These checked items describe source and isolated certification, not a production release. The connected controlled-play case and the separate side-pot, tie, disconnect, restart, pending-leave and retry cases are detailed in [the integration evidence](../changelog/2026-09-10-diamond-phase-6-shared-cash-integration.md).

## Remaining Production Acceptance

- [x] Exact production approval received for source migrations 20260910022036, 20260910023541 and 20260910030442. Applied once as production versions 20260910050142, 20260910050156 and 20260910050209. All 18 resulting function bodies match the approved source; trigger, access and closed-admission checks passed. See the integration evidence for the exact mapping.
- [x] Required CI 34440835759 passed on 2ea518146b; PR 4088 auto-merged as 85da6479df at 05:40:25 UTC. 18,616 client tests, 8,626 server tests (145 skipped), TypeScript/schema, build, accounting and 150 CSS + 13 Studio + 3 mobile cases passed.
- [x] Frontend publication and release-document adoption verified September 10 at 06:55 UTC. Both build-info endpoints serve 5b7469a5cedcb7ca80f83a637189508b8f88a2b7, built 06:47:57 UTC by publisher 34446674865. GitHub ancestry includes implementation 85da6479 and documentation merge 871e491a.
- [ ] Verify actual engine adoption. Original run 34442107723 failed before staging because its deployment-control revision was stale. Replacement run 34445622542 has staged target 06887cc30efabd12b6611c6ca9649ee7cbb2535c, whose ancestry includes Phase 6, but finished without deploying at 06:57:46 UTC because no valid maintenance certificate appeared. Cutover, verification and release sealing were skipped, not passed. At 06:56 UTC the healthy engine still served pre-integration 56962e04. The 06:53 declaration and cleanup failed on database lock timeouts. Production migration 20260909180615 intentionally requires bounded declaration retries, implemented in the existing draft maintenance PR 3908 but absent from this running engine. That shared compatibility release needs main reconciliation and its required gates before normal deployment; do not duplicate it or lengthen the database limits.
- [ ] Verify permitted authenticated production routes. The managed browser still times out before returning page state, separately from the restored Mac command connection. No live route pass or application regression is inferred from this connection failure.

Phase 6 remains open. Public funded gameplay stays closed pending the existing accounting and release criteria.

## Starting Boundaries Before This Integration

The production `fn_poker_guard_chip_seat` still refuses Diamond seats. `loadTable` still calls `assertChipFundingArena`. These remain closed until their dedicated custody integration is complete.

The shared accepted-hand chain is `fn_ca_commit_hand_settlement` to `fn_ca_commit_hand_settlement_exact_before_obligations` to `fn_ca_commit_hand_settlement_before_lease_generation`. The inner core invokes `fn_ca_settle_hand_stacks_absolute`, inserts canonical hand history, queues projection and retains the atomic commit receipt. Diamond settlement must preserve those protocol guarantees while replacing the chip financial boundary.

`fn_cashout_seat_occupancy` verifies engine authority and exact occupancy, replays retained receipts, then delegates to `atomic_seat_cashout_locked`. The Diamond implementation must retain those authority and replay semantics. The Phase 3 reserve/release adapter currently handles reserved custody only; active gameplay balances and a zero-balance exit are not yet implemented.

Production trigger inventory was inspected read-only. No production migration, balance, seat, table configuration or engine restart was changed by this increment.

## Custody Integration Contract

The continuation keeps `atomic_table_buyin` and `fn_ca_cash_buyin_receipt` as the client purchase/recovery door. Accepted hands retain the existing lease, exact seat generation, history, projection and post-commit receipt chain. Cash-out retains `fn_cashout_seat_occupancy` and its durable occupancy receipt. No alternate client wallet writer is introduced.

Custody must retain seat ID, join instant and occupancy ID. A hand may update only those matching live seats, with whole nonnegative balances and zero sum across participants. Purchase lots are held at admission; actual losses consume held units and release their reservation, while wins move existing custody value without minting. Cash-out returns the resulting custody balance. A zero exit records a zero release with no wallet journal, rather than manufacturing a credit. Any failed write rolls the transaction back.

The chip-specific promo, pending-add-on, late-seat wallet and hierarchy projection paths must not process Diamond hands. Existing money-path, lease, maintenance, seat limits, freeze and auth checks remain mandatory. Public admission stays closed until the complete integration and existing accounting release gate pass.

## Seat And Cash-Out Integration Increment

The shared `atomic_table_buyin` dispatch now has a Diamond branch that calls private custody funding, preserves the original auth/session, maintenance and immutable receipt wrapper, and binds the final database-stamped seat occupancy. The existing `fn_cashout_seat_occupancy` delegates Diamond exits to a custody cash-out in the same transaction. It retains exact occupancy receipt replay and engine-only exit authority. Deferred seat/custody checks refuse a direct stack change or live-seat deletion. Chip exit logging and chip continuity session writes exclude Diamond seats.

The platform settings gain `cash_games_enabled`, false by default, with no public setter. This is an admission switch, not permission to waive the programme release criteria. No production player or setting was changed by isolated certification. This first cash increment refuses tournament, clustered-table and optional chip-side-game configurations.

The initial isolated admission runner passed 65 assertions including its 38 prerequisite custody checks. It uses the current public purchase/session/maintenance/receipt functions, the shared occupancy stamping guard and the real custody writers. It proves simultaneous authenticated retries debit once, wrong users and revoked sessions are refused, maintenance still closes admission, a failed seat insert rolls back the already reserved wallet/lots/custody/receipt, partial-pot settlement cashes out exactly, and replay returns the original occupancy receipt. That initial run did not certify the full accepted-hand envelope or frontend. The subsequent integrated evidence below supersedes those local gaps; public funded play remains closed.

## Current Local Evidence

The completed local source includes all three financial migrations, shared engine/client integration, exact departure receipts and cross-device lobby events. Clean source `71f57c9585` passed the complete client production build and server TypeScript. Latest focused repairs passed 72 client cases, 3 rendered lobby cases and 48 engine SELECT contract cases. Admission certification passed 74 SQL assertions. Accepted-hand certification passed 50 assertions after preserving production's current table-aware settlement locks; these totals overlap prior bootstrap checks.

The connected controlled-play runner funded two authenticated players with 100 Diamonds each, ran the actual shared HandController, committed the real `[200, 0]` result through the twelve-argument SQL protocol, projected both histories, and cashed out to wallets `[1100, 900]`. All 2000 fixture Diamonds remained accounted for, with no active custody/seats, duplicate payment or chip minting. This ran only in the dedicated local test database. Exact commands and limitations are in the integration and settlement-lane changelogs. Normal publication and production verification remain separate unchecked gates above.
