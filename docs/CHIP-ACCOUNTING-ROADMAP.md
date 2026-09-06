# CHIP ACCOUNTING ROADMAP - what is done, what is left, in phases

**Written 2026-09-02 ~22:00 UTC by Claude (Cowork), from the four read-only audits in `docs/audits/2026-09-02-chip-standard-round2/` (every number below comes from a query run that evening; anything not measured is marked UNVERIFIED).**
**Companion to `docs/CHIP-ACCOUNTING-STANDARD.md` (the standard) and `docs/changelog/2026-09-02-chip-std-round2-orchestrator.md` (what shipped today).**
**Live state as of 2026-09-04: `docs/HANDOFF-CHIP-ACCOUNTING-CURRENT-STATE.md`. That document supersedes this one wherever they disagree about what is built; this one remains the map of the phases.**

## 0. The honest answer to Dan's four questions

**Is it 100% finished? No.** Player-facing tournament money now runs on the standard (one payer, a place paid once, pool-capped, engine cut over at 20:58 UTC and 186 engine obligations settled with zero refusals in the first hour). Cash-game buy-ins and cash-outs meet the standard (2,518 seat exits in 24h, 0 unaccounted). Rake distribution meets it (legs equal rake to the cent per club). The rest is graded below; three areas do not meet it yet, and one hierarchy defect is critical with a date on it.

**Were the legacy paths removed? No, and most must not be removed yet.** 27 legacy writers of the player wallet still exist (0 to thousands of uses per day). They fall into three groups: (a) 30-plus functions with zero use in 24h that are safe to drop now, (b) eleven that the running engine or a cron still calls and must be re-pointed first, (c) plumbing that the standard path itself uses. Section 3 lists them. Deletion is Phase 3, after seven days of measured zero use, because dropping a function the engine still calls is the one change that can strand a live payout.

**Were the hierarchy wallet routes audited? Not before tonight.** The first audit scoped player money only. Tonight's lane 2 mapped every union, club, super agent, agent, sub agent and player route against fourteen principles drawn from the agent-model rooms and GLI-19 / NJ DGE. Fifteen deviations, one critical: the weekly union rakeback close would either refuse forever or destroy a week of rake on its first real run (~2026-09-14). Section 2, Phase 2.

**Does what we built conflict with anything? One live conflict, fixed at 21:35 UTC.** Guaranteed-seat satellites paid failed seat awards as cash from a pool that never held the money; the new cap refused that cash. The bank now funds the seat guarantee at lock (the standard's rule; probe: pool 99 to 200, union bank minus 101, one ledger row). Ten other items checked: no conflict. Two risks: the R3 log fills with legitimate bounty writers until they are re-pointed, and five lane branches are still unmerged while their migrations are live.

## 1. Scorecard against the standard

| Area                           | Grade          | Evidence (24h unless stated)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | What is left                                                                                                                                      |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| MTT payouts                    | MEETS (bridge) | 0 over / 0 under pool on every MTT variant since cutover; obligations live                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Real escrow balance (Phase 5); bounty/refund arms still legacy (Phase 1)                                                                          |
| SNG                            | MEETS          | 817 events, 0 over, 1 under (3.80, repaired by the sweep at 20:52)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Same as MTT                                                                                                                                       |
| Spins                          | PARTIAL        | Rake exactly 8% (15,998.16 on 199,977.00), draws = prize owed, 0 shortfalls; but prize leg lands in suspense (3,303 rows / 185,189.00 per day); EV 2.7638 vs 2.760; no pending reserve at draw                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Phase 1 (declaration), Phase 5 (pending reserve, EV)                                                                                              |
| Satellites                     | PARTIAL        | Seat paid from the satellite's own pool; seat guarantee funded at lock from tonight                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Unregister returns cash not a ticket; cancelled target refunds nothing (Dan)                                                                      |
| Cash buy-in / cash-out         | MEETS          | 2,518 exits / 526,119.26, 0 unaccounted, 0 direct-connection exits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | C1 unkeyed HydraService cashout, C3 bust rebuy direct write, C5 cron cash-outs journal as adjustment; horse buy-in passes no key (2,223 of 3,201) |
| Rake collection + distribution | MEETS          | Deep Stack 36,894.83 rake = 36,894.83 legs; Midway 12,444.31 = 12,444.31; mismatch 0%                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Four ruling migrations and `credit_club_wallet_rake` not mirrored in the repo                                                                     |
| BBJ drop + payout              | PARTIAL        | Drop rule matches S10; 7 invariants at 0; payouts split to the cent; reseed same transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Allocator ignores the engine's pivot split (always 50/25/25); payout undeclared in the ledger; backup empty = silent restart at 0                 |
| Backup BBJ                     | PARTIAL        | Union pool identity 0.00 since journaling began; club pool -0.50                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | No `fn_bbj_reconcile`; no pre-08-31 opening balance (lifetime gap 73,367.70 is Dan's ruling)                                                      |
| Promo chips                    | MEETS          | Ruled 2026-09-03 (Dan): promo owes nobody anything, promo chips are ordinary chips always, and they are raked out of the pots rather than minted - so playthrough and expiry are NOT the target and that Phase 4 item is withdrawn. One owner door (`fn_promo_disburse`) wired into `WalletService.disbursePromo` and both pages; leaderboards are the only automatic payout and now have the wallet word they were missing; `clubs.promo_balance` and `clubs.insurance_balance` on the supply identity and in the trial balance; the dead `wallets(PROMO)` 10,700 retired and its four source doors shut; the splash pot's door shut until it has rules | Phase 4 is now only the leaderboard's operational proof at volume; see `docs/HANDOFF-CHIP-ACCOUNTING-CURRENT-STATE.md` sections 7.4, 7.7, 7.9     |
| Union / club / agent hierarchy | DOES NOT MEET  | 15 deviations; F1 critical (weekly close), F2 one agent per hand booked, F3 sends journaled through suspense with a phantom `table_stack`, F4 five issuance doors and an empty Mint register, F5 no `CHECK >= 0` on treasury/agent/union/player wallets                                                                                                                                                                                                                                                                                                                                                                                                  | Phase 2 and 3                                                                                                                                     |
| Controls                       | PARTIAL        | Kill switch, four-eyes table, trial balance, direct-write view, R3 log, escrow shadow all live and report-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Enforcement is Dan-gated (R3 refuse, R10 revoke, adjustment wiring)                                                                               |

## 2. The phases

Order is by money at risk, then by what unblocks the next phase. Every item ships as one PR, one migration, rolled-back probes, its own law test; anything that can refuse a live payment ships log-only first (Dan's rule) and flips on his word.

### Phase 1 - close the open doors on tournament money (this week)

1.1 **Re-point the last legacy tournament payers** at `fn_settle_tournament_obligation`: `fn_collect_bounty` (499 credits / 2,330.21 per day, the only post-cutover R3 violator), `fn_finalize_bounty_pool`, `fn_mystery_bounty_pay` and `_settle`, refunds in `atomic_cancel_tournament`, `atomic_tournament_unregister`, `fn_unregister_from_tournament`, `fn_leave_seat_and_refund`. Bounty obligations are user-keyed cumulative totals (`kind = bounty`), so a replay pays nothing. This also fixes the phantom `log_wallet_transaction` row on replay the standard found in 2.6.
1.2 **Registration debits declare themselves**: `atomic_deduct_wallet_and_log` writes 19,538 rows / 407,412.00 a day as `adjustment player_wallet -> table_stack` with no tournament id. Declare `tournament_buyin -> prize_liability` (fee leg to `fee_liability`) so the escrow is ledgered on both sides and the trial balance's `tournament_liability` row stops breaking (+44,376.80 in 5h tonight).
1.3 **Suspense to zero (R9)**: `fn_spin_settle_game` names its counterparty (185,189.00/day), BBJ promo sweeps journal both sides, horse treasury-to-felt funding gets a ledger leg (973 rows / 107,232.00). Then the suspense watcher goes from tracker to alarm.
1.4 **R3 from log to refuse** - after 24h of zero engine rows in `ca_money_path_violations` post 1.1 (Dan's flip).
1.5 **Repo hygiene**: merge #2709 #2684 #2688 #2692 #2693; mirror the 14-plus other-agent money migrations that exist only on unmerged branches; the rake guard and spin conservation tests do not run on main until the branches land.
1.6 **The 3.80 class**: DDL during play caused one winner credit failure tonight; the standard's DDL policy (batch, off-peak) is the mitigation, and the payout sweep repaired it in 31 minutes. No code change; a rule for agents.

### Phase 1 status - 2026-09-03 08:30 UTC (measured, not intended)

- 1.1 DONE. PR #2721 merged 23:04 UTC. Eight DB payers (bounty, bounty residual, mystery bounty, four refund paths) settle through `fn_settle_tournament_obligation`. `ca_money_path_violations` has received ZERO rows since 22:04:27 UTC on 09-02 (the last legacy bounty credit); the 24-hour clean window for the R3 flip (1.4, Dan's call) ends 22:05 UTC 09-03.
- 1.2 and 1.3 DONE in production, PR #2727 open. Four migrations (22:05 to 22:43 UTC): registration debits journal `tournament_buyin -> prize_liability` (1,864 legs in the last hour), the spin prize leg journals `spin_reserve -> prize_liability` (332 legs in the last hour), the horse door and the BBJ promo sweeps name both sides. `settlement_suspense` received 315 rows / 17,365 chips in the 21:00 hour and ZERO rows from 23:00 UTC through 08:05 UTC.
- 1.5 DONE. PRs #2709, #2693, #2716, #2721, #2722 (110 mirrored migrations), #2726 merged; #2688, #2692, #2684 were refused by the Silent Revert Guard on a pause-pin commit and are superseded by #2848, #2846, #2847 (same net change squashed onto current main; guard clean, lane tests and tsc green locally); #2727 carries the 1.2 / 1.3 mirrors. All four wait on the CI queue and auto-merge on green.
- 1.6 stands as a rule.
- Result: 5,779 tournaments completed between 23:00 and 08:14 UTC with 0 over-pool and 0 under-pool; 7,764 obligations, 0 engine refusals.

Two findings from the night, for Phase 1.7 and for the restart programme:

- 1.7 **Reconciler cent noise.** At 23:57 UTC `fn_tournament_payout_reconcile` asked the settle function for 0.09, 0.11 and 0.12 on three places of two events the engine had already paid to the pool exactly; the cap refused each (`escrow_short`) and filed three critical alerts. The reconciler's ladder rounds differently from the engine's largest-remainder allocation (standard 2.2 item 4). Fix: the reconciler computes expected prizes with the engine's allocation, and a total under the pool's rounding remainder is clean, not a shortfall. Until then these alerts are noise and the refusal is the function doing its job.
- **The total freeze blocks the journal but not the balance.** During the 05:00 and 06:00 UTC maintenance breaks `fn_ca_autoledger` was refused 92 `chip_ledger` inserts with `PLATFORM_FROZEN` (55006) for `bbj_pools.backup_balance` while the balance itself moved: 8.85 chips of BBJ backup are unjournaled and `fn_ca_trial_balance` shows exactly that break. One overlay ledger row (18.00, `fn_ca_fund_overlay_on_lock`) was also lost to a deadlock at 00:xx. Both are `ledger_write_failure` incidents with the existing repair arm (`fn_ca_repair_write_failure`); the structural fix belongs to the restart programme: a freeze that refuses the journal must refuse the balance write in the same statement, or exempt the journal.

### Phase 1 verification - 2026-09-03 16:00 UTC (Dan's gate before Phase 2)

- Repo: main 567043a40, root and server tsc 0 errors, 16,779 tests green, all seven CI gates pass. Engine serves 567043a4; client published at the same sha.
- Parity: every chip-std migration since the 09-02 cutoff is in the repo and normalised-equal to production; the twelve functions the standard depends on match their last repo definition; all three triggers attached and enabled. Fourteen 08-31 placeholder files (the epoch-3 reset among them) carried no body - exported byte-exact (#2856).
- Wiring: settleObligation (8 call sites), rakeSpecGuard (boot), tournamentChipConservation, seatStackCredit, config/buyIn free-buy helpers all imported and called; no legacy payer RPC left in server/src; no TODO/stub in any touched file.
- Production since cutover: 12,963 structure payouts, 0 paid twice, 0 over pool, 0 over guarantee, suspense 0.00, money-path violations 0 since 22:04:27 UTC 09-02, player wallets balance to the ledger to the cent since 00:00 UTC.
- One defect found and fixed: the overlay journal row for Late Night PKO (PLO4) lost a deadlock at 00:31:49 (18.00, union bank; balances right, row missing). Restored (correction:lwf:704); migration 20260903155801 retries 40P01 and names the bank in its failure message (#2856).
- Left for their owners: 92 frozen BBJ auto-ledger rows (8.85, restart programme), a 400-chip table_stack drift in the 12:05 restart hour (not tournament money), the "seat missing or left" hand-write refusals (pre-existing, self-healing), post-deploy-e2e red since 09-01 (E2E account, lobby waitlist). Details: docs/changelog/2026-09-03-chip-std-pre-phase2-verification.md.

### Phase 2 - the hierarchy ledger (before 2026-09-14)

2.1 **Weekly union rakeback close (F1, CRITICAL)**: the live `fn_union_weekly_rakeback_close` debits the union bank by the payout AND the rake treasury by the period total, credits the retained share nowhere, and its guard demands the bank cover a treasury payout. Rewrite the money section for separate pots with a conservation assert (in = out to the cent), rolled-back sim on the real period before the freeze lifts. Last run 08-20; the settlement freeze holds until 09-07.
2.2 **Commission accrues for every agent in the chain per hand (F2)**: the accrual guard `EXISTS(source_id, source_type)` lacks `user_id`, so one agent per hand is booked (26,271 rows for 26,271 hands; a four-agent hand booked once). Add the user to the key, backfill nothing (obligations, not credits).
2.3 **One payer per obligation (F6/F7)**: `fn_agent_claim_commission` becomes the sole commission payer (cascade round 2 retired); one rakeback payer at `fn_player_rakeback_rate` (today: a hardcoded ladder from the treasury vs a contract rate from the agent wallet - two payers, two rates). 3,287 pending rakeback rows / 299,025.98 and 708,635.15 of unsettled commission move onto the trial balance as liabilities (F8).
2.4 **Hierarchy sends are ledgered in substance (F3)**: club bank send/claim/reverse, agent send/claim/self-stake, union-to-club sends and clawbacks declare `fn_ca_declare_ledger` categories; the `table_stack` default that invents a felt leg is dropped; suspense stops taking 182,131.56 a day from these.
2.5 **Doors closed (F9/F10)**: revoke the seven orphan money RPCs (`fn_wallet_claim_back` is an unlimited agent pull that contradicts the 10-minute rule; `calculate_cascading_commission` is anon-executable); approver plus reason above a threshold on sends and mints (tonight: a 7.6M send and an 18M free top-up by a single actor); daily adjustments report (NJ 13:69O-1.3(i)).
2.6 **RULED by Dan 2026-09-03, and F11 is withdrawn**: promo chips are treated exactly like regular chips, always. They are raked out of the pots, so they are the same chips, they owe nobody anything, and the whole point is to give them back to the players to spend in the union or club. There is no playthrough and no expiry to build. Promo is disbursed manually by owners (`fn_promo_disburse`, 20260903224815/20260903225020) and leaderboards are the only automatic promo payout (fixed and proven, 20260903225121/20260903225331).

2.7 **DONE 2026-09-03 - per-game-type rakeback rates** (Dan: "GO AHEAD AND DO THIS"), the one thing ClubGG and PokerBros had that we did not: `union_clubs.rate_cash/rate_mtt/rate_sng/rate_spin/rate_satellite`, resolved per game type per club, falling back to `club_commission_rate` then 0.90, truncated per (club, game type) so a remainder stays with the union. Migration 20260903224025. All columns NULL on arrival, so no club's deal changed.

**PHASE 2 IS COMPLETE.** Every item above is applied to production, mirrored byte-exact, and covered by a law test.

### How many phases are left (Dan asked, 2026-09-03)

Seven phases, plus the epoch reset gate that sits between Phase 4 and Phase 5.
**Phases 1 and 2 are complete**, so five remain:

| phase | what it is                                                                    | why it is not optional                                                                                                                 |
| ----- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 3     | one Mint, no negative balances, the legacy paths deleted                      | today's `CHECK (balance >= 0)` is missing on the club, agent and union balances, and 30-plus dead money functions are still executable |
| 4     | the jackpot: one BBJ allocator, `fn_bbj_reconcile` per pool, the lifetime gap | the BBJ is the only pot without an opening balance it can prove                                                                        |
| gate  | the epoch reset, all unions and clubs                                         | gives Phase 5 trustworthy opening figures; entered only on seven measured clean days                                                   |
| 5     | escrow becomes a balance                                                      | the last place a tournament's money is a counter rather than a balance                                                                 |
| 6     | controls that enforce                                                         | the kill switch, four-eyes and alert board are report-only until this                                                                  |
| 7     | optimisation: ledger replay, partitioning, PITR drill                         | none of it is load-bearing, all of it is how the standard stays true                                                                   |

Phase 4's promo half is already done, ahead of its phase, because Dan ruled on
promo on 2026-09-03; what remains in Phase 4 is the jackpot.

### Phase 3 - one Mint, no negatives, legacy deleted

**The Mint, audited and hardened 2026-09-04 19:40 UTC (Dan's instruction, after Phase 3).** Register append-only with one row per leg (unique index); doors link their leg by key; an issuance ceiling (`ca_mint_policy`: 10M per operation, 25M per rolling 24h) refused in the door and again at commit for every door; overview reconciles register against meter as of the snapshot; `origin` on every row; `mint_club_chips` / `mint_club_promo` closed. `docs/changelog/2026-09-04-the-mint-hardened.md`.

**Defect 0 (the felt), closed 2026-09-04 before 3.1 - measured, not intended.** The hourly -1,300 to -2,700 unexplained supply drift was two defects: mid-hand and between-hands seat credits erased by the engine's ABSOLUTE stack write when its memory was stale (a settlement-barrier bug shipped 2026-08-31, plus the unchecked per-seat fallback that ran on a quarter of cash hands because the no-op trigger made the atomic write report failure), masked in part by standalone-club tournament rake journalled as leaving `table_stack`. Fixed structurally: the hand write is now a DIFFERENCE (`stack_before` per seat, rake and BBJ declared, identity asserted on every write, credits the engine never saw preserved and recorded in `ca_seat_stack_rebases`), the barrier chains, the fallback is gone, the rake declaration is honoured. 282 erased credits / 33,626.88 chips restored to 180 players through a keyed door from `issuance_reserve`; a self-retiring sweep covered the hours until the engine shipped (retired 19:23 UTC: in delta mode its detector read the engine's memory as the felt and restored 15 preserved credits / 3,867.99 a second time, absorbed under 10.9 rule 3; `20260904192338`). `docs/changelog/2026-09-04-chip-std-felt-erasure.md`.

**Phase 3 gate passed 2026-09-04 20:35 UTC** (everything merged and published: ca_sha 91c458c37, World Hub a18ebe5b; gates green; wiring read live; the tail of 3.3 is the seven-day DROP soak). Named for Phase 5: tournament-table refused writes (defect 11) and quarter-chip payout rounding. `docs/changelog/2026-09-04-chip-std-phase-3.md`.

**Phase 3 status - 2026-09-04 19:00 UTC (measured, not intended).** 3.1 DONE: the register follows the journal (deferred constraint trigger on `chip_ledger`), 32 legs of the era backfilled, an opening baseline per estate written in the meter's own snapshot so that `fn_ca_mint_register_vs_supply()` reads difference 0.00 on 193,144,847.90; the diamond mint declares the Mint. 3.2 DONE: 18 validated `CHECK (col >= 0)` constraints across `clubs`, `club_members`, `union_wallets`, `agents`, `table_seats`, `bbj_pools`, applied at 18:51 on the second attempt after one deadlock against live writers. 3.3 FIRST CUT: 17 names / 19 overloads with zero calls in 46h of `pg_stat_statements` and no caller anywhere are revoked from every client role and registered `closed`; the DROP follows seven days of silence. The World Hub callers are now VERIFIED, not assumed: eight of the roadmap's functions are called by World Hub API routes and stay open until those routes are re-pointed. 3.4 (R10) not started, gated on 3.3 finishing. `docs/changelog/2026-09-04-chip-std-phase-3.md`.

3.1 **All issuance through `fn_ca_mint`** (today `ca_mint_ledger` has 0 rows while 29.2M was issued in 30 days through five doors: diamond mint, free top-up, opening grants, two others); a retire door; `fn_ca_mint` / `fn_ca_burn` revoked from `authenticated`; burn registered.
3.2 **`CHECK (balance >= 0)`** on `clubs.chip_treasury`, agent float, `union_wallets`, `club_members.chip_balance` - `NOT VALID` then `VALIDATE` off-peak (the standard's "already" on player wallets was wrong; the DB has the constraint only on `spin_bonus_pools`, `club_wallets`, `tournament_obligations`). No store is negative today, so validation will pass.
3.3 **Delete the legacy paths** - the safe-now list from lane 1 (30-plus functions with zero use: `fn_ca_fund_club`, `fn_mint_club_chips_zd3core`, `fn_credit_treasury_zd4core`, `fn_mint_chips_from_diamonds`, `mass_fund_horses`, `distribute_chips`, `deduct_chip_balance`, `add_chips`, `increment_union_chip_balance`, the `lock_/unlock_chips_*` family, `fn_atomic_buyin`, `fn_pay_player_chips`, `fn_credit_chips`, `fn_debit_chips`, `atomic_tournament_register`, `fn_tournament_atomic_register`, `atomic_tournament_unregister`, `fn_tournament_unregister_counter`, `increment_tournament_rake`, the three `increment_rake_generated`, `record_rake`, `fn_ca_settle_hand_stacks`, `spin_pool_deposit/draw`, `fn_resolve_bbj_pool`, `atomic_table_cashout`, `fn_agent_approve_cashout`, every `public.wallets` writer and the fallback branches inside `atomic_credit/deduct_wallet_and_log` and `fn_credit_player_wallet_once`, `fn_admin_kick_player`, `fn_admin_close_table`, `fn_union_close_club_tables_for_join`, `fn_leave_seat_and_refund`, `chip_escrow_holds`, `chip_supply_snapshots`). Gate: seven days of zero use measured by the R3 log and `ca_direct_balance_writes`, World Hub API callers checked (UNVERIFIED tonight), then REVOKE for 24h, then DROP. Then the eleven re-pointed in Phase 1 and 2 follow the same gate.
3.4 **R10**: `REVOKE UPDATE` on balance columns from every role but the definer owner - the change that makes "an agent ran a migration" impossible. Gated on 3.3 because today it would block buy-ins.

### Phase 4 - promo chips and the jackpot

**Phase 4 status - 2026-09-04 21:25 UTC (measured, not intended).** 4.1 was ruled and built on 09-03 (promo model). 4.3 DONE: one allocator (`fn_bbj_allocate` on `ca_bbj_policy`; the engine's portions are ignored), the union pool's 38 hours of post-pivot over-allocation (4,245.25) moved main to promo from the rows, bank moves declared and recorded (`fn_bbj_move_between_banks`, `ca_bbj_bucket_moves`), an empty reserve at reseed is an incident, the payout declares `bbj_pool -> table_stack` and pays a departed recipient's TABLE club wallet by key, funding and the backup transfer declare, `pool_amount` no longer journalled, seven retired stubs closed, Deep Stack Society admitted to the incident scope. 4.2 DONE: a labelled opening balance per bank per pool (`ca_bbj_pool_snapshots`, 21:17:14 UTC) with the 73,367.70 lifetime gap written into it and left readable, `fn_bbj_reconcile` per bank against the journal in one statement, run hourly from the existing rake/BBJ audit, `bbj_error` on a two-snapshot disagreement; `fn_bbj_conservation_check` healthy on the epoch, unhealthy on the lifetime, both visible. The lifetime residue is for the epoch reset gate. `docs/changelog/2026-09-04-chip-std-phase-4.md`.

4.1 **One promo issuance function** with `promo_playthrough_required`, expiry, and a funded source (`clubs.promo_balance` or the union promo wallet), converting to cash only by playthrough; retire `fn_promo_wallet_send`, `redeem_promo_to_chips`, `distribute_promo_chips` and the three front-end callers of `add_to_promo_wallet`; fix `fn_bbj_promo_payout_atomic` so a locked grant can release; put `clubs.promo_balance` and `wallets(PROMO)` (10,700 stranded) into the supply identity or retire them.
4.2 **`fn_bbj_reconcile()` per pool** (`main + backup + promo = seed + contributions - payouts - restorations`) with a monthly snapshot table so the identity has an opening balance; alert when backup is empty at reseed; Dan's ruling on the 73,367.70 lifetime gap (71,749.31 of it is `total_paid_out` with no `bbj_payouts` row, pre-journal).
4.3 **One BBJ allocator** honouring the engine's pivot split instead of the fixed 50/25/25; `bbj_atomic_payout_v2` declares its ledger category and credits seats through the pending-addon path (C3 twin).

**Addendum - 2026-09-05 03:50 UTC (Dan's missing promo chips).** Union promo to a club lands in the club promo wallet (Dan's ruling, PR #3065). The chip standard closed what the journal showed: `fn_union_send_to_club_atomic` (the Club Bank route) and the `bbj_main` branch of `fn_union_promo_send` now declare keyed rows instead of landing in suspense, and `fn_club_promo_wallet_send` is registered (`20260905034557`; `docs/changelog/2026-09-05-chip-std-union-to-club-routes-declare-themselves.md`). Every union to club route is on the audit list for the next gate.

### The epoch reset gate - between Phase 4 and Phase 5 (Dan, 2026-09-02: all unions and clubs)

A clean slate is an EPOCH, not an erase: journals stay append-only, history is never rewritten, and every retirement is a ledgered burn. Scope is the whole estate as it exists today: Midway Union (`fade0000`) with its member clubs SHARK CLUB (`a41434bb`, 593 members) and Club JAQK (`a0000000`, 584 members), and the standalone Deep Stack Society (`2a1132b9`, 417 members). The machinery exists from the zero-drift work and was measured on 09-01: `fn_ca_epoch3_preflight` (dry-run default), `fn_ca_execute_epoch3_reset` (needs the literal `MIDWAY-EPOCH-3-RESET` and a passing preflight), `fn_ca_epoch3_cert_fleet_reset` (optional, 52 cert accounts / 15.79M), and the 24-hour acceptance gate `fn_ca_midway_burnin_gate(24)`. Today it is Midway-scoped; the work item is to widen it to the three clubs and the union, one call per entity, same preflight.

Entry conditions (all measured, none waived): Phases 1 to 4 landed; seven consecutive days with `fn_ca_trial_balance` at 0.00 on every account, `settlement_suspense` net 0.00, `ca_money_path_violations` empty for the engine, `tournament_escrow_shadow` balancing every completed event, `fn_ca_supply_snapshot` unexplained 0; no open critical incident; the union weekly close (2.1) proven on a rolled-back real period.

Sequence, per entity, at a hand boundary inside the maintenance break: (1) close registration, let running tournaments finish or cancel-and-refund through the obligation path; (2) cash every seat out through `atomic_seat_cashout_locked`, humans and horses alike; (3) retire what should never have existed with ledgered burns to `chip_retirement`: the 89.76M horse mint, the 732.59M dead `public.wallets` pool, cert-fleet supply if Dan says so; (4) settle or write off, by Dan's ruling and through four-eyes adjustments, the historic obligations: rakeback 281,108.01, commission 708,635.15 / pending rakeback 299,025.98, the 73,367.70 BBJ lifetime gap, the 1,109 MTT overpayment and 92 satellite mint (standing ruling: no clawback); (5) declare opening balances per account into `ca_supply_snapshots` and a new `ca_bbj_pool_snapshots` row per pool; (6) run the burn-in gate for 24 hours; (7) reopen. Real players' club chips in the three clubs are NOT touched by any step: that is their money, and only an explicit ruling from Dan could change a player balance.

What the reset gives Phase 5: exact opening figures, so the escrow floor of zero and the zero-at-close assertion are trustworthy from the first event of the new epoch. What it does not give: any fix to a path - which is why it sits after Phase 4, not before Phase 1.

### Phase 5 - escrow becomes a balance (the end state of the standard)

**Phase 5.1 status - 2026-09-05 03:05 UTC (measured, not intended).** DONE in three migrations (`20260904220932`, `20260905025630` inside the 02:55 freeze, `20260905025642`): `tournament_escrow` holds prize, bounty and fee banks derived from their components and maintained by six triggers in the same transaction as every operational row the shadow trusts; an outflow below zero is refused inside the write (`P0403 escrow_short`) and `fn_settle_tournament_obligation` reads the balance before it credits; an unknown event opens from the shadow on first sight; 422 live events opened in the freeze; a close with prize or bounty left is an incident; the hourly shadow compares itself to the balance; spins tracked, not refused; the supply meter reads the escrow. First minutes live: 28 prizes through the balance, 13 closes at zero, 0 refusals. The counters stay as counters the pages read; making them views is a later cut. 5.2 (spin `pending` as a column) and 5.3 (tickets, Dan's ruling) named. `docs/changelog/2026-09-04-chip-std-phase-5.md`.

**Phase 5.2 status - 2026-09-05 08:00 UTC (measured, not intended).** The spin escrow carries the reserve (`reserve_out` at pool completion, `reserve_in` at the draw, from the legs the engine writes, one trigger on `chip_ledger`), so its banks are exact: 1,699 completed spins at 0.00, 76 live ones equal to their journal to the cent. The supply meter reads the escrow for every event with a row; the spin step is a labelled register correction. Spins stay tracked, not refused, until a soak. The 09:05 snapshot, the first full hour under the final definition, read -6.13 unexplained (felt boundary noise); the residue the three definition changes left on the register (496.05) is closed with one labelled correction and the Mint card reads difference 0.00. Also: the platform freeze had been refusing the journal leg of bank writes it let stand (104 BBJ legs, 9.69 chips); the guard now passes a leg written from inside another trigger, and the BBJ repair sweep checks the freeze (`20260905074227`, `20260905075122`; `docs/changelog/2026-09-05-chip-std-phase-5-2-the-spin-escrow-reads-the-reserve.md`). Open: the felt loses about 3 chips an hour to what reads as odd-chip rounding at pot splits (measured next); flipping spins to enforced after the soak; the `SPIN_TIERS` rebalance is Dan's.

**Phase 5 gate - 2026-09-05 20:20 UTC (measured, not intended).** Everything in Phase 5 verified live and on `main`: 1,866 enforced closes at zero, 0 refusals, drift 1,096/0, meter flat all day (|unexplained| < 7), difference 3.88. The gate found and closed seven things, each probed rolled back first: the spin book-entry deadlock; four unregistered doors and the redrive sweep in the freeze; #3065's mirror versions; spins enforced (13,346 measured safe); the seat reads the leg; a cash entrant who wins a seat is paid the seat (200.00 paid under 10.9); 5.3 ruled and built (cancel refunds every satellite seat; a cancel's fee reversal is never escrow money). `docs/changelog/2026-09-05-chip-std-phase-5-gate.md`. Phase 5 is closed; Phase 6 next.

5.1 `tournament_escrow(prize_balance, bounty_balance, fee_balance)` with `CHECK >= 0`, fed by registration, rebuy, add-on, overlay, satellite transfer, settle, cancel; `prize_pool` / `bounty_pool` / `total_rake` become views; the settle function debits escrow in the same statement as the wallet credit (R1 at the constraint, not in code); close asserts all three are zero (R5) or holds the event in COMPLETING with an incident. The escrow shadow built tonight is the dry run: it already balances 3,819 of 3,826 events to the cent, so the migration is a promotion, not a rewrite.
5.2 Spin `pending` sub-balance reserved at draw; shortfall refuses at draw, never adjusts; `SPIN_TIERS` rebalanced to `|E[m] - 3 x 0.92| < 1e-4` (today 2.7638 vs 2.760, effective rake 7.874%).
5.3 Satellite tickets as a liability (`ticket_liability`) when Dan rules on unregister/cancel.

### Phase 6 - controls that enforce

**Phase 6 status - 2026-09-05 21:00 UTC (measured, not intended).** 6.1 DONE: a settlement from outside the platform names an approved `ca_manual_adjustments` row or is refused; the agent's row is written under Dan's standing 10.9 grant with the paragraph and the migration. 6.2 DONE: the kill switch trips itself at 1,000 chips on the supply, BBJ or escrow meters and freezes tournament and jackpot payouts until a human clears them. 6.3 DONE: `ca_detector_registry` (owner, SLA, retire, clear window), `v_ca_alert_board`, two detectors retired, 54 stale findings cleared on the first tick. 6.4: every leg names its hand or its event; dedupe stays on the door by design; partitioning measured and planned as its own dated cut before December. `docs/changelog/2026-09-05-chip-std-phase-6-controls-that-enforce.md`.

**Phase 6 gate - 2026-09-05 22:40 UTC (measured, not intended).** Phase 6 verified live: 40 crons green including all three kill-switch meters, 1,144 settlements and 0 false refusals, 0 kill-switch trips against a 1,000 threshold on hourly readings of 1.24 / 0.00 / 5.44, 0 incidents from a retired detector, 5,854 of 5,854 drop legs naming their hand. Three findings closed. The one that mattered: Phase 6.2's kill switch opened the payout freeze itself, which `tests/law/PayoutFreezeIsHumanOnly.law.test.ts` forbids in as many words; production was disarmed and `20260905224524` rewrote it to ESCALATE (a person opens the freeze). Today's own meter proves the law: an armed switch would have frozen every payout at 03:05 on a definition change, not a leak. Whether it is ever armed to freeze is Dan's, with the cost written down. Two gaps closed (`20260905223231`): a detector filing without a registry row now registers itself as unassigned (the board could not have shown it), and a prize_liability side names the event on every category while a table_stack side names the table - after which ZERO legs carry no hand, no event and no table. `docs/changelog/2026-09-05-chip-std-phase-6-gate.md`. Phase 6 is closed; Phase 7 next.

6.1 `p_adjustment_id` on the settle function requires an approved `ca_manual_adjustments` row; migrations that credit wallets fail R3.
6.2 Kill switch automation at Dan's threshold (proposed 1,000 chips/hour break on escrow or BBJ).
6.3 Alert board: an owner and a 24h SLA per detector; auto-resolve on clear; retire every detector that R1-R11 make impossible.
6.4 `chip_ledger.idempotency_key` populated (NULL on 126,559 of 126,593 rows tonight) so the ledger dedupes by itself; monthly partitioning before month four.

### Phase 8 - every account is replayable

**Phase 8.1 status - 2026-09-06 01:22 UTC (measured, not intended).** DONE. The replay's last blind spot is closed: 579 legs a day carried no column it could key (a union wallet has six, an agent two, and the counterparty side of a leg carries no label). The rule is exact - THE OTHER SIDE OF A LEG NAMES WHAT MOVED, and the entity's identity decides which promo column - and the migration refuses to apply unless the unkeyable count is zero. A flaw inherited from the BBJ meter's two-interval rule was fixed with it: a residue that already cancelled was being counted twice along the chain, so the snapshot now carries the CUMULATIVE residue and a finding needs two consecutive intervals moving it the same way. Two runs, each in one snapshot: **1,012 accounts, 0 unkeyable, 1 disagreement** - the felt, at 10 to 25 chips, which is the engine writing a hand's stacks and its legs in two transactions. `docs/changelog/2026-09-06-chip-std-phase-8-every-account-is-replayable.md`.

8.2 C3: the bust rebuy goes through the pending ledger.
8.3 The PITR drill.
8.4 `chip_ledger` partitioning, before December, blocked on the `ca_mint_ledger.chip_ledger_id` foreign key (a partitioned parent's unique key must carry the partition column).
8.5 The engine settles a hand in one transaction, so the felt stops disagreeing with its own journal by the size of the in-flight population (engine lane).

### Phase 7 - further optimisation (after the above)

**Phase 7 gate - 2026-09-06 00:50 UTC (measured, not intended).** The replay's first judged run filed 159 findings and every one was the replay's own keying: an account keyed by the club on the leg split one union wallet into two, the felt was replayed per table where a sanctioned seat move carries a stack between tables with no leg, and a missing club_members row read as a zero balance. Corrected (`20260906003739`): the account is the OWNER of the chips and the felt is one pool. Same window after: 1,009 checked, 9 disagreements, every large one reading two-interval 0.00. The edge itself is closed by running the nightly job in one REPEATABLE READ snapshot (`20260906004441`). 7.2 verified live (5 of 6 new horse legs name their player, no caller broken). `docs/changelog/2026-09-06-chip-std-phase-7-gate.md`.

**Phase 7 status - 2026-09-05 23:20 UTC (measured, not intended).** The kill-switch ruling is made (mine, handed back by Dan): the switch NEVER freezes, it escalates with its own second opinion - EXPLAINED (a register correction or a migration that re-created the meter, in the window), CONFIRMED (the previous reading agreed in sign) or UNCONFIRMED - and a person opens the freeze; the gate for ever arming an automatic freeze is a week inside +/- 50 an hour, written down. 7.1 DONE: `ca_account_snapshots` + `fn_ca_ledger_replay` check, per account, that the change between its own two readings equals the journal's net over the same interval; first real run read 2,030 accounts. Excluded and said so: prize_liability (the escrow is its balance) and 579 unkeyable legs a day. `docs/changelog/2026-09-05-chip-std-phase-7-the-journal-replays-every-account.md`. 7.2 DONE: a horse funding names its player and takes an optional key that answers a replay once (9,252 legs in seven days named nobody). C5 closed by measurement (player_leave_table already declares table_cashout). The seat-award 400 stays UNVERIFIED and needs its reproduction rather than a blind fix. Carried: PITR drill, C3 (bust rebuy through the pending ledger), and chip_ledger partitioning (its own dated cut before December).

Nightly ledger-replay sampling (derive balances from the journal and diff); daily attestation and hash manifests already exist - add the replay; PITR drill; horse buy-in idempotency keys; C1 (`HydraService` unkeyed `atomic_table_cashout` call, `atomic_table_withdraw`), C3 (bust rebuy through the pending ledger), C5 (cron cash-outs declare their category); `fn_award_satellite_seat` rake row for fee-0 targets; the `400` on seat award at 20:14 (UNVERIFIED, likely the four-game cap - a player at the cap should be told before the satellite starts).

## 3. Decisions that are Dan's (consolidated, one line each)

1. R3 refuse - DONE 2026-09-03 22:35 UTC, my call at Dan's instruction ("THERE IS NOTHING THAT'S MY CALL"). Zero violations in 25h against 18,017 in-scope credits; 344 more in the first half hour after the flip, still zero. The mode is a row in `ca_money_path_enforcement`, so the way back is `UPDATE public.ca_money_path_enforcement SET mode = 'log';`. 2. R10 revoke (after 3.3). 3. Delete list in 3.3 - confirm the seven-day gate. 4. Union rakeback close model (separate pots - DONE 09-03, migration 20260903161443; who eats a short treasury - today it refuses whole). 4b. DONE 09-03 (Dan's ruling): a member club's share is 90% of the rake ITS PLAYERS generated at the union's cash tables, MTTs, spins and SNGs (ca_union_rake_attribution + tournament_players; migrations 20260903211722 / 20260903212129); last 24h basis JAQK 71,425 / SHARK 67,409 of a 139,311 day. 5. Commission: sole payer and contract rate (priced 09-03: pending rakeback 352,752.25 at the row ladder vs 420,427.87 at the contract rate, 1,200 rows differ; fn_ca_hierarchy_payables shows both per club). 6. Hierarchy four-eyes threshold. 7. Promo - RULED 2026-09-03: promo owes nobody anything, promo chips are ordinary chips always, and they are raked out of the pots rather than minted. Disbursed manually by owners to clubs and players; leaderboards are the only automatic payout. Built and proven (docs/changelog/2026-09-03-chip-std-promo-model.md). 8. Union spending held rake on members (F12). 9. BBJ lifetime gap 73,367.70. 10. Satellite unregister and cancel: cash, ticket, or refuse. 11. Satellite seat guarantee now costs the bank ~2,600 per cycle at today's fields - confirm or change `satellite_seats`. 12. 1,109 real MTT overpayment and 92 satellite mint: no clawback. 13. Kill-switch threshold. 14. C4 restart sweep everyone or nobody. 15. Rakeback 281,108.01 and commission 708,635.15 owed. 16. The epoch reset (ruled 2026-09-02: all unions and clubs): the cert-fleet wipe, the dead-pool retirement, and each historic write-off named in the gate section are separate one-word calls at reset time.

## 4. How to read progress

`fn_ca_trial_balance(now() - interval '24 hours')` names the account that drifted; `ca_money_path_violations` counts the legacy tournament writers still alive; `tournament_escrow_shadow` shows every event's held-versus-paid; `ca_direct_balance_writes` shows who wrote a balance outside a declared path. When all four read zero for seven days, Phase 3's deletions are due.

## The board clearance - 2026-09-06 (status: DONE)

Dan, 2026-09-06: "finish up everything thats still pending and not finished OR
STILL NEEDS TO BE FIXED, IMPROVED, ENHANCED OR OPTIMIZED STILL."

`financial_alerts` held **894 open rows**; it holds **294**. Read one class at a
time they were four real defects, one stale baseline, one repair queue nobody
was draining, and 152 rows of my own noise.

| what the board said                                  | what it was                                                                                                                                                                                | migration                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 246 x "tournament paid out money it never collected" | the conservation delta read the guarantee overlay from a side table that only ONE of the two funding paths writes; the union bank had paid every one of them and journalled it             | `20260906015217` (+ two indexes, `20260906015837`, `20260906020707`) |
| 151 events still short after that fix                | guarantees paid before `fn_ca_fund_overlay_on_lock` existed to fund them, 2026-07-24 to 2026-09-03, 39,685.56 chips; acknowledged, not clawed back                                         | `20260906021514`                                                     |
| 3 x critical "the dead pool changed by -10,700.00"   | the baseline had not followed the authorised phantom promo retirement of 2026-09-03; it may now move only beside a recorded reason                                                         | `20260906022011`                                                     |
| 180 x "unbanked BBJ contribution"                    | duplicate rake rows, not lost chips - `atomic_distribute_rake` keyed BOTH idempotency guards on a hand id that is NULL on the engine's first call, and its leg key was a fresh random uuid | `20260906023024`                                                     |
| 21 x critical "ledger write failure"                 | 116 swallowed journal rows and a working drain nobody had called; 113 legs written back, no balance touched                                                                                | `20260906023900`                                                     |
| 152 rows of mine                                     | a detector retired at the Phase 6.3 gate, and four replay runs superseded by the migrations that followed them                                                                             | `20260906021758`                                                     |

Left open on purpose: the felt's -10.74 (engine item 8.5), the 30
`escrow:<id>` residues (the epoch reset gate's list, Dan's), and one diamond
audit row that is not a chip leg.

Recorded and NOT acted on: 4,452 duplicate rake rows carrying **16,426.46 of
over-attributed rake** between 2026-04-16 and 2026-09-05. The producer is
closed. Only 371 can be proven duplicates from surviving hand rows; the rest sit
behind five months of VIP points and agent commissions already paid, and
restating settled earnings is a decision to be taken deliberately.

Carried into Phase 8: 8.2 (the bust rebuy goes through the pending ledger),
8.3 (the PITR drill), 8.4 (`chip_ledger` partitioning before December), 8.5
(the engine settles a hand in one transaction).

### 8.3 - the PITR drill (status: MEASURED, restore rehearsal still open)

Measured on production 2026-09-06 02:48 UTC, because a chip and balance reset
must not be the first time anyone asks whether the platform can be put back.

| what                  | reading                                             |
| --------------------- | --------------------------------------------------- |
| `wal_level`           | `logical`                                           |
| `archive_mode`        | `on`                                                |
| `archive_command`     | `/usr/bin/admin-mgr wal-push %p` (wal-g)            |
| `archive_timeout`     | 120 seconds - the worst-case RPO                    |
| WAL segments archived | 22,358                                              |
| **archive failures**  | **0**, since the counter was reset 2026-09-02 21:04 |
| last archive          | 10 seconds before the reading                       |
| database size         | 126 GB                                              |

So point-in-time recovery is armed and healthy, and the recovery point is at
worst two minutes behind. What is NOT yet done is a rehearsal: restoring to a
branch and proving the restored copy reconciles. That is the remaining half of
8.3 and it costs a 126 GB restore.

**It is also not the right safety net for the reset.** A reset should be
reversible by construction - the closing position of every account recorded
before anything is zeroed - rather than by rolling the whole platform back two
minutes at a time. PITR is the net under the net.

## Phase 9 - what the standard still does not say (proposed 2026-09-06)

Dan asked what else belongs here. These are not leftovers from phases 1-8; they
are things the standard has never covered. Each one is grounded in something
measured today rather than proposed from general principle.

### 9.1 ONE DEFINITION OF A CHIP (do this before the reset)

A chip has three different definitions in this schema right now:

| shape                    | columns                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `numeric(_,2)` - correct | `chip_ledger.amount`, `club_members.chip_balance`, `table_seats.stack`, `clubs.chip_treasury`, `wallet_transactions.amount`, all three `bbj_pools` banks, `spin_bonus_pools.balance`                                                                                                                                                    |
| `numeric(_,4)`           | `agents.agent_wallet_balance`, `agents.player_wallet_balance`, `agents.promo_wallet_balance`, `club_wallets.chip_balance`, `rake_records.rake_amount`, `tournaments.total_rake`                                                                                                                                                         |
| unconstrained `numeric`  | `union_wallets.chip_balance` and `.rake_wallet`, `tournament_escrow.prize_balance` / `.bounty_balance` / `.fee_balance`, `tournament_payouts.amount`, `tournaments.prize_pool` / `.bounty_pool`, `clubs.chip_pool`, `wallet_transactions.balance_after`, `chip_ledger`'s four pre/post balance columns, `rake_attributions.rake_amount` |

A balance that can hold four decimal places, against a journal that can only
record two, is a rounding leak by construction: the fraction lives in the
balance and can never appear in a leg.

**It has not happened yet.** Every one of those columns was checked on
2026-09-06 and there is not one sub-cent residue in live data. That is exactly
why this is cheap now: declare the unit, add the CHECK, and it can never open.
Doing it after a reset means doing it against balances that have already
started to drift.

### 9.2 THE ATTESTATION LIVES INSIDE THE THING IT ATTESTS

`ca_ledger_day_manifests` is the right idea and it works - one row per day with
`row_count`, `first_seq`, `last_seq`, `net_amount` and a `sha256`, seven days
deep. But it is a row in the same database as the journal it hashes, so it
proves the journal has not been altered only to somebody who already trusts the
database. Anchor the daily sha somewhere with a different owner - a commit in
this repo, an object in S3, an email - and the proof becomes worth something.
One line a day.

### 9.3 THERE IS NO RESTATEMENT POLICY, AND IT WAS NEEDED TODAY

The 2026-09-06 clearance found 16,426.46 chips of rake attributed to clubs by
duplicate rows, spread over five months and already paid out as VIP points and
agent commissions. 10.9 says a past event's money is the agent's to settle and a
future event's terms are Dan's. **A restatement of settled earnings is neither**,
and the standard says nothing about it: who decides, at what size, what a player
or agent is told, and whether the correction is a clawback (forbidden), a
write-off (what happened), or a re-run. I made the call and wrote down why. The
next agent should be reading a rule, not repeating my judgement.

### 9.4 THE JOURNAL HAS NO RETENTION OR ARCHIVE POLICY

232k rows a day, 1.68M rows and 1.3 GB today. 8.4 partitions it, which is a
storage answer, not a policy: nobody has written down how long a leg is kept,
what happens to a partition when it ages out, or where it goes. A journal that
can be silently dropped is not a journal. This has to be settled in the same
work as 8.4, not after it.

### 9.5 A PLAYER CAN ALREADY AUDIT THEIR OWN CHIPS, AND HAS NOWHERE TO DO IT

`chip_ledger` carries RLS - a player may read any leg where they are
`performed_by`, `from_entity_id` or `to_entity_id` - and no surface anywhere
shows it. A standard nobody outside the team can check is half a standard, and
this is also the cheapest support tool on the platform: "where did my chips go"
answers itself. Same for a club operator and their treasury.

### 9.6 THE SECOND WRITER HAS NEVER BEEN AUDITED

Phase 5 registered every money door in the database. The World Hub carries its
own money routes under `pages/api/club-arena/`, in another repo, and nothing has
ever been checked against that register. A door is only closed if both repos
agree it is closed.

### 9.7 THE OTHER CURRENCIES HAVE NO LEDGER AT ALL

Diamonds have their own programme and their own drift. **VIP points, rakeback
and agent commissions have no journal, no meter and no conservation check** -
they are liabilities the platform owes, tracked only as counters. That is
precisely why 9.3's 16,426.46 was invisible for five months: rake attribution
has nothing to reconcile against. The chip standard should either extend to
them or say plainly that it does not, and why.

### 9.8 THE RESET IS A PHASE, NOT AN EVENT (Dan: Monday)

`ca_financial_epochs` already exists with `is_current`, which is the right hook.
A reset needs its own contract: the closing position of every account recorded
and journalled before anything is zeroed, the reset itself inside a :55 freeze
with nobody seated, one migration able to put every balance back, and the
opening grants issued through the Mint so the new epoch starts from a known
number rather than an assumed one. PITR is measured healthy (8.3) and is the net
under the net, not the plan.

---

# PART TWO — THE CONTINUATION BUILD PLAN (2026-09-06)

Three handoffs arrived at once: the 894-alert backlog, the horse-hand recording
proposal, and the chip/diamond triage brief. Everything below was **measured on
production before it was written down**, and several of the headline numbers did
not survive that.

## What the audit actually found

### The alert backlog is a third the size it reads, and doubled

379 unresolved, 135 critical — not 894/165; the alert-board pass on 2026-09-05
closed most of it. Of what remains, **30 rows are literal duplicates**: the drift
pipeline files a `drift_incident:financial_alerts:<source>` wrapper beside every
native alert, so each of those events is on the board twice.

### `settlement_barrier_abandoned` was ten a day; it is three shutdowns

Fifteen rows, all reading "exceeded 300s", all carrying `waitedMs: 30000`.
Thirty seconds in a message claiming three hundred, on a loop whose timeout
condition was still true. It exited on `this.running`. Three SIGTERMs, five
tables each, one second apart. **Underneath it sat a real hole**: `drainHands`
counted a stopped engine as drained while `postHandTasks` was still writing, so
the process exited on top of in-flight money at :55 every hour. That is Phase 1,
shipped with this document.

### The 9.98M treasury divergence is an opening balance, not a leak

`ca_treasury_baseline` already registers the unledgered opening gap for three
clubs, taken 2026-08-31 10:45. My own recomputation from `chip_ledger` matches
all three **to the cent** (33,223,391.23 / 8,450,449.72 / 9,766.78). The fourth,
Deep Stack Society, was created at 19:02 — eight hours after the snapshot — so it
has no baseline row and its entire opening treasury reads as drift forever. The
gap is **constant**: measured twice minutes apart, journal and stored moved 17.53
in lockstep and the gap did not change by a cent. Two structural defects:

- the baseline is a **one-shot snapshot with no rule for clubs born after it**;
- only `reconcile_ledger_nightly` subtracts it. `fn_ca_quick_reconcile` and
  `fn_ca_auto_reconcile_tick` do not, so they re-report the three explained clubs
  endlessly. That is most of the `treasury_error` noise, and it is why the same
  fact appears under `reconcile:` and `qr:` prefixes.

### The frozen-pool 10,700 is already retired; 0.30 is not

`ca_frozen_pool_baseline` was moved to 732,581,294.33 for the authorised phantom
promo retirement. The pool actually holds 732,581,294.03. **A residual of 0.30
chips that no change record explains** — trivial in size, but the pool's own rule
is that any movement is a critical, and this one was not refused.

### The horse-hand proposal: C yes, the gate no

The load problem is real (1,854 kB/s WAL against 1,880 kB/s capacity is not
headroom, it is a coin flip, and it fails as a spiral because a lagging slot
reads WAL from disk). But **skipping the `hand_history` write breaks 10.5 for
recording**, and 10.5 is binding and explicitly rejects "equal outcome by a
different mechanism". Worse, it is irreversible: data not written cannot be
backfilled, and bounty attribution reads those rows to decide who busted whom in
tournaments that pay real chips.

Alternative A ("keep the row, kill the cascade") is **not the safe middle it
looks like** — those seven triggers feed `player_stats`, VIP points and the
rakeback basis, so skipping them for horses is the _exact_ shape of the
`is_horse` filter that 10.5 exists because of. Only **C (partition and DROP
PARTITION)** is both a large win and a pure storage decision with no player
treatment in it, and it is already roadmap 8.4. B (slim row) is worth costing.

**The gate itself is Dan's ruling, not mine.** Retention is the precedent: Dan
decided the 7-day horse-only prune himself, on the record, as a storage decision.
This is the same question one step further and I will not carve into 10.5 on my
own authority. It goes to him as options with costs — which is what 10.8 requires
when a written law and a proposal collide.

## The phases

Each is shipped, published and verified before the next starts.

| #     | Phase                                                                                                                                                      | Why here                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **1** | **The drain waits for the money; the barrier names the right fault**                                                                                       | Recurs hourly, engine-side, and it is money. Ship first. |
| 2     | The board separates signal from noise: baseline as a rule not a snapshot, every detector subtracts it, kill the wrapper double-filing, rank by materiality | Nothing else can be trusted until the board can be read  |
| 3     | One definition of a chip — scale 2 on every balance column (9.1)                                                                                           | Cheap now, expensive after a reset re-bases everything   |
| 4     | The remaining three of the triage brief: the 619,829 diamonds, the supply-unexplained buckets, the 0.30 residual                                           | Small, real, and each needs its own trace                |
| 5     | Realtime load: partition + `DROP PARTITION` (8.4 / handoff C); the horse-recording gate put to Dan with costs                                              | Orthogonal, reversible, no law question                  |
| 6     | The attestation is anchored outside the database (9.2); the journal gets a retention policy (9.4)                                                          | A hash stored beside what it hashes proves nothing       |
| 7     | A player can audit their own chips (9.5); the second writer is audited (9.6)                                                                               | RLS already permits it; no surface exists                |
| 8     | The other currencies get a ledger — VIP points, rakeback, commissions (9.7)                                                                                | Why the 16k stayed invisible for five months             |
| 9     | The reset is a phase, not an event (9.8); the restatement policy (9.3)                                                                                     | `ca_financial_epochs.is_current` is the hook             |

## Phase 1 — DONE

See `docs/changelog/2026-09-06-the-drain-waits-for-the-money.md`.
Pinned by `server/src/engine/TheDrainWaitsForTheMoney.law.test.ts`.

---

## THE 323 INCIDENT SWEEP (2026-09-06) — and what it changed about the plan

Read one at a time, per Dan. **323 open -> 86; criticals 135 -> 25.** Full
account: `docs/changelog/2026-09-06-the-323-open-drift-incidents.md`.

**Dan's ruling, mid-sweep, now binding on this programme:**

> "WE AREN'T USING ANY CRONS TO MONITOR OR FIX, THATS A BANDAID, NOT A HARD
> CODED SOLUTION. WE NEED TO FIX THE ISSUES AT THE CODE LEVEL. NOT CONSTANTLY
> RUNNING AROUND RECONCILING. I WANT NOTHING BUT CODE BASE FIXES FOR ANY AND
> ALL CHIP DRIFT ISSUES."

Every remaining phase is re-scoped against this. A repair sweep, a backfill
pass or a reconciliation job is **not** an acceptable answer to a drift; the
answer is the write that cannot lose. Two sweeps I scheduled during this session
were unscheduled again in `20260906100735`.

This retires the "detector + repair" pattern the earlier phases leaned on. It
does **not** retire detectors — a detector says whether the code fix worked. It
retires the repair as the fix.

### Re-ordered remaining work, each one a code fix

| #   | what                                                                                 | the code fix, not the sweep                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2a  | Bomb award units                                                                     | **Done, pending engine deploy.** One transaction via `fn_ca_insert_hand_with_awards`. The constraint trigger goes on in the same PR once the engine can satisfy it. |
| 2b  | Escrow residue (30 incidents)                                                        | The SNG/heads-up close path never drains the fee sub-balance. Fix the close, not the leftovers.                                                                     |
| 2c  | The live 2,523.48 (7 incidents, kill switch tripped)                                 | One account disagrees with its journal. Find the write that skipped a leg.                                                                                          |
| 2d  | Deep Stack Society treasury (5 incidents)                                            | A club created after the baseline snapshot has no opening row. Give club creation the row, rather than a snapshot that ages.                                        |
| 2e  | Diamond supply, insurance offers, R3 credits, the 0.30 residual                      | One write path each.                                                                                                                                                |
| 3   | One definition of a chip — scale 2 everywhere (9.1)                                  | unchanged                                                                                                                                                           |
| 4+  | Attestation, retention, player statement, second writer, other currencies, the reset | unchanged                                                                                                                                                           |

### Two corrections of mine from this session, recorded so they are not repeated

1. **I answered a drift with a cron.** Rejected and reverted.
2. **I attached a constraint trigger before the engine could satisfy it**, then
   dropped it on a misreading (a 2m41s gap in bomb pots whose normal maximum gap
   that hour was 489s; and three unit-less hands committed while it was live, so
   it was not blocking anything). A rule must land with, or after, the code that
   can obey it — never before.
