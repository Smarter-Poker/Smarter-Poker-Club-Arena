# Diamond Phase 6: Shared NLH Cash Game

Status: Complete. Public Funded Diamond Games Remain Closed.

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
- [x] Actual engine adoption verified. Normal deployment 34449341468 cut over to 86aab0e645b1842e83fca808cf956c9733af66ba at September 10, 07:55:59 UTC, then passed runtime verification, promotion, database version movement and durable release sealing. Deploy attempt 354 recorded shipped=true. At 12:31:09 UTC engine and both frontend endpoints serve descendant f1992eeb825918d6614d72a10c66988d0cdd292c; engine status/liveness/settlementStatus are ok with zero blocked settlements. GitHub ancestry proves inclusion of implementation 85da6479 (ahead 33, behind zero) and release docs 1434f002 (ahead 10, behind zero). Earlier skipped deployments and the historical maintenance compatibility issue do not negate this completed adoption.
- [x] Permitted authenticated production routes verified September 11, 2026 between 13:57:58 and 14:23:32 UTC, and the one defect they found was repaired, published and rechecked at 15:06:28 UTC. Exact route evidence, the defect and its repair are recorded in the live acceptance section below. The earlier managed-browser timeouts were a tooling failure and remain historical evidence; no application regression was ever inferred from them.

Phase 6 is closed on this evidence. Public funded gameplay stays closed pending the existing accounting and release criteria: `cash_games_enabled` remains false, and no player, seat, balance, table or admission setting was changed during acceptance.

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

## Authenticated Live Acceptance, September 11, 2026

Attribution: Claude drove these checks itself, in the Claude desktop app's built-in browser pane on Dan's Mac, after Dan signed in there with his own Smarter.Poker account, which is a joined Shark Club member. The agent handled no credential, read no browser session secret, and touched no tab in Dan's own Chrome. The pane rendered 354 to 680 pixels wide, so the mobile layout was the one exercised. Every route was read from the live DOM after load, and screenshots were reviewed in session. Dan authorized dismissing the platform's own entry notice before the wallet check.

Served build during the route checks: `/hub/club-arena/build-info.json` returned `ca_sha` 7fca22664fac59d4a291de9bab167a5be279efdf at 13:57:58 UTC (built 13:50:31 UTC by publish-club-arena.yml run 34606055862), and bd5247763020e5c8e50797871222e91e7ebca7c9 by 14:23:32 UTC (built 13:58:35 UTC, run 34607181704, conclusion success). Both are descendants of implementation 85da6479 and release documentation 87f7c6dd with those commits as exact merge bases. Engine health at 14:06:36 UTC identified 14794f7d with status, liveness and settlementStatus ok and zero blocked settlements, and included implementation 85da6479 (ahead 143, behind zero).

### Route Results

- Route A, 13:57:58 to 13:58:21 UTC. `/hub/club-arena/` rendered the Poker Arena home. The Diamond Arena card appeared automatically beside Shark Club and the other joined clubs, labeled "Diamond Arena - Click To Enter Lobby". Clicking it opened the canonical Diamond route showing "You Are Already A Member." and "Diamond Games Are Not Open For Play Yet." No join application was required or offered. PASS.
- Route B, 13:59:10 UTC, reload at 14:01:08 UTC. The UUID route `/clubs/002c2d27-9584-4e52-835a-bb2be148fc81` canonicalized to `/clubs/diamond-arena`; both keys resolve through `isDiamondArenaClubKey` in `src/lib/constants.ts`, so the UUID and the slug are one route. The page identified Diamond Arena, carried both required lines verbatim, and finished loading Available Diamonds 494,590 and Diamonds In Play 0 as numbers. The DOM contained no NaN, no "Loading Diamond Balance", no "Diamond Balance Unavailable", no Join control, no chip-management footer, no Diamond Club Operations rail and no public funded-play action. One reload (navigation type confirmed `reload` at 14:01:22 UTC) returned the same screen and the same balances. PASS.
- Route C, 13:59:34 UTC. `/clubs/.../finance` canonicalized to `/clubs/diamond-arena/finance` and rendered only the safe Diamond shell: membership line, closed-games line, both balances and the wallet button. No chip cashier, no club finance management, no unauthorized operations. PASS.
- Route D, 13:59:56 UTC. `/clubs/.../agents` canonicalized to `/clubs/diamond-arena/agents` with the same safe shell. No agent hierarchy, no commissions, no agent management, no union text, no chip operations. PASS.
- Route E, 14:00:16 UTC. The stale invitation `/invite/diamond-arena` redirected to `/clubs/diamond-arena` and rendered the member shell with balances. No Join button was pressed, no invitation acceptance existed to press, and no membership mutation was needed. PASS.
- Route F, 14:00:47 UTC. `/clubs/shark-club` rendered the joined chip club's normal game lobby: Shark Club header and identity, My Wallets, Bad Beat Jackpot, live club schedule and a 302+ game list with View Game and Join Game controls. No application error boundary, no indefinite loading, no newly generated seat-query ambiguity error, and no Diamond policy text replacing the chip club's lobby. The platform's ordinary hourly maintenance-break notice was present and is not a Diamond fact. PASS.
- Diamond Wallet, 14:22:51 to 14:23:10 UTC. "Open Diamond Wallet" opened the wallet: heading Diamond Wallet, Available Diamonds 494,590, Diamonds In Play 0, the Buy Diamonds and Send Diamonds controls, and the Diamond transaction history. It was closed again without submitting any action. No transfer, purchase or top-up was started. PASS.

Console: 80 messages accumulated across the routes and zero were error level. All were pre-existing warnings unrelated to Diamond code: a preloaded club-card frame image reported unused, an unrecognized `ambient-light-sensor` Permissions-Policy feature, and the auth guard rehydrating a valid stored session.

Observation, not a defect: a fresh browser profile shows the shared Club Arena entry notice, "Welcome To Poker Arena", once. It is the platform notice every profile sees before entering, not a Diamond join requirement, and the Diamond shell rendered correctly beneath it.

### Defect Found And Repaired

The acceptance found one real layout defect. The Diamond shell reuses `.club-home` for the black stage and the bottom-nav clearance, and inherited that class's chip-lobby geometry with it: the desktop two-column grid, and the mobile full-bleed offset `width: 100vw; margin-left: calc(50% - 50vw)` that the unified mobile lobby resets for itself and the Diamond shell did not. Measured at 13:57 UTC on a 680 pixel viewport, the shell computed `margin-left: -4px` with no side padding, so the heading, the membership lines, the balances and the wallet button all began at x = -4 and were clipped at the left edge. On a desktop viewport the placeholder's four lines were auto-placed across the two-column grid rather than stacked.

The repair is a scoped double-class rule in `src/components/arena/DiamondArenaShell.css` that lays the shell out as one padded column at every width and holds `margin-left` at zero where `.club-home` goes full bleed, plus `tests/unit/diamondArenaShellLayout.test.ts`, which reads the stylesheet so the override cannot be tidied away. No behavior, route, wallet, admission or money path was touched.

PR [4313](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4313) from `agent/codex-diamond-phase-6/fix/diamond-shell-layout`, source d44bc402df, squash merged as 29b6ae08b20ca34b575d27492370d4cf5ad1bd67 at 14:54:00 UTC. The pre-push hook ran the new pin (2 passed) with no bypass; required CI passed before autopilot merged. Publisher run 34612890316 built 15:00:16 UTC and both build-info endpoints served 29b6ae08.

Recheck at 15:06:28 UTC on served 29b6ae08, after clearing the browser's own caches so the new chunk was fetched: the shell now computes `display: flex`, `margin-left: 0px` and `padding-left: 12px`, the heading starts at x = 12, and the section spans 0 to 672 inside a 680 pixel viewport with nothing off canvas. The membership lines, both balances and the wallet button all render unclipped. Ancestry of the served build: implementation 85da6479 ahead 153 behind zero, release documentation 87f7c6dd ahead 119 behind zero, each the exact merge base. Engine health at 15:06:51 UTC still identified 14794f7d with status, liveness and settlementStatus ok and zero blocked settlements.

### What Was Not Done

No player transfer, purchase, deposit, buy-in, cash-out or seat action. No balance, admission setting or public funded test table. No production migration reapplied. No engine restart, host image tag, container or release seal touched. No completed implementation suite rerun to repeat prior evidence. The isolated controlled-play certification remains the funded-flow evidence for this phase.
