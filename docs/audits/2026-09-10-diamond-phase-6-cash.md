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

## Remaining Phase 6 Acceptance

- [ ] Atomic Diamond seat acquisition: bind existing custody to exact seat occupancy without chip funding or chip ledger writes.
- [ ] Accepted-hand settlement: retain the shared lease/generation/history protocol and update Diamond custody atomically, preserving purchase-lot provenance and exact replay.
- [ ] Occupancy-bound cash-out: release the actual settled balance, including a busted zero balance, with strict rollback and durable retry receipts.
- [ ] Wire the shared client buy-in/leave/history/result/wallet-refresh flow to the Diamond financial boundary.
- [ ] Controlled multi-user certification against isolated PostgreSQL: full play/cash-out conservation, all-in, side pot, tie, disconnect, restart, pending leave and response-loss retry; assert no chip or hierarchy writes.
- [ ] Merge, publish and verify the actual served frontend/engine source plus permitted authenticated routes.

## Inspected Current Boundaries

The production `fn_poker_guard_chip_seat` still refuses Diamond seats. `loadTable` still calls `assertChipFundingArena`. These remain closed until their dedicated custody integration is complete.

The shared accepted-hand chain is `fn_ca_commit_hand_settlement` to `fn_ca_commit_hand_settlement_exact_before_obligations` to `fn_ca_commit_hand_settlement_before_lease_generation`. The inner core invokes `fn_ca_settle_hand_stacks_absolute`, inserts canonical hand history, queues projection and retains the atomic commit receipt. Diamond settlement must preserve those protocol guarantees while replacing the chip financial boundary.

`fn_cashout_seat_occupancy` verifies engine authority and exact occupancy, replays retained receipts, then delegates to `atomic_seat_cashout_locked`. The Diamond implementation must retain those authority and replay semantics. The Phase 3 reserve/release adapter currently handles reserved custody only; active gameplay balances and a zero-balance exit are not yet implemented.

Production trigger inventory was inspected read-only. No production migration, balance, seat, table configuration or engine restart was changed by this increment.

## Custody Integration Contract

The continuation keeps `atomic_table_buyin` and `fn_ca_cash_buyin_receipt` as the client purchase/recovery door. Accepted hands retain the existing lease, exact seat generation, history, projection and post-commit receipt chain. Cash-out retains `fn_cashout_seat_occupancy` and its durable occupancy receipt. No alternate client wallet writer is introduced.

Custody must retain seat ID, join instant and occupancy ID. A hand may update only those matching live seats, with whole nonnegative balances and zero sum across participants. Purchase lots are held at admission; actual losses consume held units and release their reservation, while wins move existing custody value without minting. Cash-out returns the resulting custody balance. A zero exit records a zero release with no wallet journal, rather than manufacturing a credit. Any failed write rolls the transaction back.

The chip-specific promo, pending-add-on, late-seat wallet and hierarchy projection paths must not process Diamond hands. Existing money-path, lease, maintenance, seat limits, freeze and auth checks remain mandatory. Public admission stays closed until the complete integration and existing accounting release gate pass.
