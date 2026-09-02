# Lane 4 audit - BBJ, Backup BBJ, Promo chips, Spins, SNG + cash, Rake distribution

Read-only audit, 2026-09-02 ~21:00-21:40 UTC, against production `kuklfnapbkmacvwxktbh`
(live `pg_get_functiondef` bodies + queries) and the engine at
`.agent-trees/club-arena/claude-chip-standard` (origin/main f36a11c3e, branch
`fix/a-correction-is-not-a-mint` where noted). Nothing was written, applied or pushed.

Graded against `docs/CHIP-ACCOUNTING-STANDARD.md` S2, S9, S10, S16 (1.1), 2.3-2.5, 3.2.

Note: production Postgres reported `FATAL 57P03 the database system is shutting down`
from 21:01 to ~21:09 UTC (project status `RESIZING`, then `ACTIVE_HEALTHY`). Two cash
hands settled in that window (21:01:26-27) have a `rake_records` row with BBJ > 0 and
no `bbj_contributions` row yet (0.53 chips); `fn_bbj_repair_unbanked` runs every 15 min
(`ca-bbj-repair-unbanked-15m`) and re-banks exactly that case.

---

## A. BBJ + BACKUP BBJ - grade: PARTIAL

### A.1 Drop rule (S10) - MEETS

Live `fn_effective_bbj_drop(bb, players_dealt, saw_flop, club, table, variant, sb, pot, rake)`:

- ineligible variants -> 0; `NOT saw_flop` -> 0; `players_dealt < ca_rake_rules.bbj_min_players_dealt` -> 0;
- per-table gate `tables.bbj_percent > 0` (an explicit 0 disables the table);
- fee = `round(bb * bbj_fee_bb, 2)` from `fn_rake_stake_price` (fallback `fn_rake_tier_price`) - fixed per stake, not a % of pot;
- clamp: `IF rake + fee > pot THEN fee := fee - overage` - **BBJ yields first**, rake keeps its number.

Engine mirror: `RakeConfig.ts` `BBJ_RULES.minPlayersDealt = 3`, `HandController.ts:3211`
gates on `bbjCfg.enabled && flopCounts && playerCount >= minPlayersDealt`. The engine
gate is `tables.bbj_percent` (`ServerTableEngineDealing.ts:2067`), NOT `clubs.bbj_enabled`
/ `clubs.bbj_rake_enabled` - those two club columns are read by nobody in `server/src`.

24h invariants (`SELECT * FROM fn_rake_bbj_invariants(24)`):

| check                            | violations |
| -------------------------------- | ---------- |
| I1_drop_under_3_dealt (heads-up) | 0          |
| I2_drop_on_ineligible_variant    | 0          |
| I3_deductions_exceed_pot         | 0          |
| I4_eligible_flop_no_drop         | 0          |
| I5_drop_not_banked_to_pool       | 0          |
| I6_ledger_not_reconciled         | 0          |
| I7_raked_hand_never_banked       | 0          |

Tournament tables: `ServerTableEngineSettlement.ts:1655` gates the contribution on
`!this.isTournamentTable()`. 24h: `rake_records` with `is_tournament AND bbj_contribution>0` = **0**;
`bbj_contributions` joined to `tables.tournament_id IS NOT NULL` = **0**; joined to
`hand_history.tournament_id IS NOT NULL` = **0**.

### A.2 Contribution row keyed (pool, hand) - MEETS, with two notes

Live `bbj_record_contribution`: `INSERT ... ON CONFLICT (pool_id, hand_id) WHERE hand_id IS NOT NULL DO NOTHING`;
a `hand_id IS NULL` call is deduped by lookup on `(pool, table, hand_number)` only (no constraint).
The pool credit declares `app.ledger_category = bbj_contribution`, counterparty `table_stack`, so
each drop journals as `table_stack -> bbj_pool` (41,371 rows / 5,049.41 in 24h; ~3 rows per
hand because the autoledger journals main/backup/promo columns separately).

Split is computed CUMULATIVELY in the DB (`alloc_cum_amount`): main = 50%, backup = 25%,
promo = remainder. No truncation: `sum(main+backup+promo) = amount` on every row since March
(`bucketed = contrib_rows` on both live pools, see A.6). 365 rows / 3.65 of
`bbj_pool -> table_stack` in 24h are the cumulative allocator's negative penny corrections,
not money leaving the pool.

Note 1 - **the DB ignores the engine's split.** `logBBJCollection` (`bbj.ts:53-58,161-165`)
computes the Dan-2026-08-18 pivot (25/25/50 once main >= 100,000) and passes
`p_main_portion/p_backup_portion/p_promo_portion`; the live function never reads those three
parameters and always applies 50/25/25. `fn_bbj_repair_unbanked` DOES apply the pivot. Union
main is 98,189.72 now, so the pivot has not mattered today; it will silently not engage at 100k.
Header comment in `RakeConfig.ts:13` still says "Main 40% / BackUp 30% / Promotional 30%" (stale).

Note 2 - `fn_bbj_repair_unbanked` writes portions per hand (not cumulative) and does not
advance `alloc_cum_amount`; penny drift between the two allocators is bounded but real.

24h banking: 15,135 raked hands with BBJ (5,080.04); 0 amount mismatches between
`rake_records.bbj_contribution` and `bbj_contributions.amount`; 13 rows (3.95) with
`hand_id IS NULL` (repair path, keyed by table+hand_number). `rake_records` vs `hand_history`
over 28,722 hands: rake 49,399.40 = 49,399.40, bbj 5,181.28 = 5,181.28, 0 mismatches.

### A.3 Payout `bbj_atomic_payout_v2` - MEETS on split/reseed, PARTIAL on ledgering

- Idempotent on `(pool_id, table_id, hand_number)` (UNIQUE on `bbj_payouts`), replay re-drives
  any recipient that was not credited (`bbj_payout_recipients (payout_id, user_id)` UNIQUE).
- `total = LEAST(round(main * pct), main)` - **clamped to MAIN only**; backup is never a payout source.
- Split 50% loser / 25% winner / 25% table; table share = `per * n` after rounding, the rounding
  remainder goes to the loser - so `loser + winner + table = total` to the cent. Verified on the
  last 30 days: 19 hits, `sum(total) = sum(loser+winner+table) = sum(recipients) = 62,163.18`.
- Reseed: `IF main <= 0 THEN fn_bbj_reseed_main_from_backup(pool)` in the same transaction
  (transfer, not payout: `main := backup; backup := 0`).
- **Backup short:** if backup is 0 the main simply restarts at 0. No alert, no incident, no refusal.
- **Ledgering (by code, UNVERIFIED live - last hit 2026-08-19):** the function sets no
  `app.ledger_category`; the `bbj_pools.main_balance` debit will autoledger as
  `bbj_pool -> settlement_suspense (adjustment)`; a seated recipient is credited by
  `UPDATE table_seats SET stack = stack + amount` (no journal row at all); a departed recipient via
  `credit_player_wallet` (autoledgers from suspense). Not the S3 "one row, both sides".
- `bbj_credit_one_recipient` does `stack += amount` while the engine's `syncStacks` writes stacks
  absolutely (standard C3) - the credit can be erased on the next sync.
- Recipient set = `p_dealt_in_ids` (dealt in), seated flag from `p_seated_ids`; horses included.

### A.4 Backup pool

Funded by 25% of every drop (cumulative allocator), plus `fn_union_bbj_backup_transfer` /
`fn_union_fund_bbj_pool` (union-owner tools, ledgered through `union_wallet_transactions`).
Balances now: union pool `f9806a7f` backup **26,779.50**, Deep Stack Society pool `a7a65cfc`
backup **964.09**. Ledgered: yes since 2026-08-31 (autoledger on the `backup_balance` column).
Reconciled: only through the GLOBAL lifetime check (A.6) - there is no per-pool, per-bank reconcile.

### A.5 `bbj_pools.promo_balance`

Fed by the 25% promo slice of every drop. Drained by `fn_sweep_bbj_promo(club)` /
`fn_sweep_bbj_promo_all()` (cron), which move it to `union_wallets.promo_wallet` (union clubs)
or `clubs.promo_balance` (union-less clubs), and by `fn_bbj_promo_payout_atomic` (pool promo ->
`club_members.promo_balance`, keyed, split to the cent). Balances now: 0.17 / 0.03 / 6.80 total.

24h sweep ledgering:

| leg                                                                          | rows | amount   |
| ---------------------------------------------------------------------------- | ---- | -------- |
| `bbj_pool -> settlement_suspense (adjustment)` (the sweep debit, undeclared) | 505  | 1,260.05 |
| `settlement_suspense -> promo_wallet (clubs.promo_balance)`                  | 254  | 936.71   |
| `union_wallet_transactions bbj_promo_sweep credit`                           | 251  | 323.34   |
| chip_ledger row for the union `promo_wallet` credit                          | 0    | **0.00** |

So the sweep declares no ledger category on either side; the club leg is caught by the
`clubs` autoledger, the union leg (**~324/day**) is not journaled at all and sits in suspense.
Neither `clubs.promo_balance` (977.12) nor the dead `wallets(PROMO)` pool (10,700) is inside
`fn_ca_supply_snapshot`'s total, so every club-side sweep reads as ~-940/day "unexplained".

### A.6 The identity `main + backup + promo = seed + contributions - payouts - restorations`

There is no per-pool snapshot older than 2026-08-31 14:52 (`ca_supply_snapshots` starts then, and
holds only the bbj TOTAL), so a true 30-day opening balance per pool is **UNVERIFIED**. Three
things CAN be measured:

**(a) Ledger-chain reconcile per pool since journaling began** (pre/post balance of every
`chip_ledger` row on each `bbj_pools` column must chain; a gap = a write that bypassed the ledger):

| pool             | column | rows   | opened      | opening   | ledger net | implied closing | unledgered net |
| ---------------- | ------ | ------ | ----------- | --------- | ---------- | --------------- | -------------- |
| f9806a7f (union) | main   | 13,234 | 08-31 14:41 | 95,139.05 | +3,055.33  | 98,194.38       | **0.00**       |
| f9806a7f         | backup | 13,055 | 08-31 14:41 | 25,253.99 | +1,527.84  | 26,781.83       | **0.00**       |
| f9806a7f         | promo  | 13,195 | 08-31 14:41 | 240.66    | -238.45    | 2.21            | **0.00**       |
| a7a65cfc (club)  | main   | 11,100 | 09-01 14:59 | 1,022.90  | +1,926.66  | 2,949.56        | -0.25          |
| a7a65cfc         | backup | 10,836 | 09-01 14:59 | 11.45     | +963.34    | 974.79          | -0.13          |
| a7a65cfc         | promo  | 10,946 | 09-01 14:59 | 11.45     | -1.54      | 9.91            | -0.12          |

Variance since journaling: union pool **0.00** on all three banks; club pool **-0.50** total
(three cent-level gaps during the 09-01 15:08 clean-slate reset). 24h window: 0.00 on all six.

**(b) Lifetime identity from the row tables per pool**
(`contributions + funded + restorations_in - restorations_out - payouts - promo_swept - balance`):

| pool                     | balance    | contrib rows | payout rows | swept     | rest in/out    | variance                                                                                    |
| ------------------------ | ---------- | ------------ | ----------- | --------- | -------------- | ------------------------------------------------------------------------------------------- |
| f9806a7f union           | 124,972.55 | 226,737.47   | 26,689.80   | 57,692.49 | +56,938.27 / 0 | **+74,321.90**                                                                              |
| a7a65cfc club            | 3,909.15   | 3,919.77     | 0           | 964.82    | 0              | -954.20 (= +977.10 mgmt-api top-up on 09-01 17:06 and the 45.80 pre-reset residue; 0 since) |
| 0867a7fd retired_settled | 0          | 159,981.85   | 74,301.10   | 28,742.48 | 0 / -56,938.27 | 0.00                                                                                        |

**(c) The global check** `fn_bbj_conservation_check()`: inflow 390,631.27, outflow 188,390.69,
balances 128,872.88, **gap 73,367.70**, baseline 2,572.59, drift 70,795.11, `healthy: false`.
`fn_bbj_gap_decomposition()`: `remainder_unexplained 73,367.70`.

Where the 74k sits: the union pool's COUNTERS disagree with its ROW tables.
`total_contributed` 386,718.82 vs contribution rows 226,737.47 (the 159,981 difference is the
merged club pool's history - fine); `total_paid_out` 172,740.21 vs payout rows 26,689.80 +
74,301.10 merged = 100,990.90 -> **71,749.31 of payouts are counted in the counter with no
`bbj_payouts` row** (`bbj_ledger_deletions` is empty, but that guard only exists since 08-31).
The baseline note says 41,096.65 of it is March contribution rows whose portions were never
bucketed, and ~33k is unexplained. This is the open investigation Dan froze settlement for on
08-26; it is not moving (0.00 drift since journaling) but it is not closed either.

`fn_bbj_reconcile()` as the standard asks (per pool, monthly, variance > 1.00 = incident):
**does not exist**. The nearest thing is the global lifetime check above, which has been red at
~73k since 08-25 and cannot say which pool or which bank.

---

## B. PROMO CHIPS - grade: DOES NOT MEET (as a liability model); no mint

### Where promo lives (balances now)

| store                                                   | balance                                                                                                | in supply identity? |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- |
| `union_wallets.promo_wallet`                            | 37,694.64                                                                                              | yes                 |
| `clubs.promo_balance`                                   | 977.12                                                                                                 | **no**              |
| `agents.promo_wallet_balance`                           | 0 (supply counts this) / `agents.promo_balance` 0 (older column, `distribute_promo_chips` debits this) | partly              |
| `club_members.promo_balance`                            | 0.00 (0 members)                                                                                       | yes                 |
| `bbj_pools.promo_balance`                               | 6.80                                                                                                   | yes                 |
| `wallets` WHERE wallet_type='PROMO' (dead pool, frozen) | 10,700.00 (447 rows)                                                                                   | no                  |
| `club_opening_setups.leaderboard_seed_remaining`        | 500.00                                                                                                 | yes (`lb_liab`)     |

### Issuance - funded or minted?

**Funded, not minted.** `mint_club_promo` is a stub that refuses
("promo chips cannot be minted; all promo derives from the BBJ"). The only live issuance is the
25% BBJ promo slice (57,695.27 lifetime into the union promo wallet; 29,719.60 into
`clubs.promo_balance`), plus `fn_union_fund_promo_from_bank` (union bank -> promo, both sides
in `union_wallet_transactions`). Union promo wallet reconciles exactly:
57,695.27 in - 20,000 spin seed - 0.63 reversal = 37,694.64.

The funding SOURCE is the players' pots (the BBJ drop), not the operator - so the
"operator-funded at issuance" half of the industry rule is met only in the sense that it is
already-collected money; nothing is created.

Residual mint path: `add_to_promo_wallet(user, amount)` credits the dead `wallets(PROMO)` pool
with no debit; it is still called by `PromotionService.ts:438,502`,
`AchievementService.ts:520`, `AchievementTriggerService.ts` (front end). The `wallets` table now
has `guard_wallet_balance_write` + `zz_freeze_guard` triggers, so those calls fail rather than
mint; last PROMO wallet write 2026-09-01 01:41. The callers are dead code that should be removed.

### Conversion - playthrough

`promo_apply_playthrough` (engine-only, called per hand from `ServerTableEngineSettlement.ts:1707`)
releases `club_members.promo_balance -> chip_balance` only when `promo_wagered >= promo_playthrough_required`,
ledgered as `promo_release` vs `promo_wallet`. Correct shape. But only ONE function ever sets
`promo_playthrough_required`: `transfer_promo_agent_to_player` (3x), and it debits
`club_members.promo_balance` of the AGENT - a column nobody funds. Every other grant path bypasses playthrough:

- `fn_promo_wallet_send` (the UI's canonical path, `WalletCashierModal.tsx:890`,
  `AgentPromoPanel.tsx:265`): `agents.promo_wallet_balance -> club_members.chip_balance` -
  **cashable chips immediately, no playthrough, no `app.ledger_category`** (lands in suspense).
- `distribute_promo_chips` (`WalletService.ts:519`): `agents.promo_balance -> club_members.chip_balance`, same.
- `redeem_promo_to_chips`: `club_members.promo_balance -> chip_balance` on demand, no playthrough, no ledger declaration.
- `fn_bbj_promo_payout_atomic`: pool promo -> `club_members.promo_balance` **without setting
  `promo_playthrough_required`**, so `promo_apply_playthrough` returns `no_outstanding_promo`
  forever and the chips can only leave via `redeem_promo_to_chips`.

Usage: no promo has ever reached a player through any of these
(`chip_transactions` types seen: `bbj_promo_sweep` 669 rows, `promo_closed_on_union_join` 1,
`bonus` 4 (2,450, 08-20/21); zero `promo_wallet_send` / `promo_agent_to_player` /
`bbj_promo_payout` / `promo_released` rows). 24h promo movement = the BBJ sweeps only.

### Payout paths

- Leaderboard: `fn_payout_leaderboard` (migration 20260901074000) - seed -> club promo ->
  treasury overlay waterfall, refuses if unfunded, batch receipt with
  `CHECK (total_paid = seed + promo + overlay)`, winners via keyed `fn_credit_and_log`. Correct
  shape (funded before credit). Never run: 0 batches, 1 failure ("No Paid Leaderboard Program
  Applies To This Round"). Union-funded branch sets no ledger GUC.
- Promotions: `trg_promotion_prize_has_no_payout_path` (warn trigger) - 4 rows totalling 9,500
  advertised, no payout function exists.
- Expiry: none. No promo balance ever expires back.

---

## C. SPINS - grade: PARTIAL

Live bodies read: `fn_spin_book_entry`, `fn_spin_draw_multiplier`, `fn_spin_settle_game`,
`fn_spin_move_owner_wallet`. The live `fn_spin_book_entry` IS the branch version
(`the_spin_treasury_credit_double_paid_the_rake`, on `fix/a-correction-is-not-a-mint`, not on
main): no direct treasury credit, a `rake_records` row `source='fn_spin_book_entry'`, and the
rake is settled once at completion by `fn_settle_tournament_rake` (UNIQUE on tournament_id).

### Money path vs 3.2

1. Buy-in -> `fn_spin_book_entry` when the last seat is paid: `reserve_in = collected - 8%`
   into `spin_bonus_pools`, declared `spin_entry` vs `prize_liability`. MEETS.
2. Draw `fn_spin_draw_multiplier(tiers from engine SPIN_TIERS)`: pool row `FOR UPDATE`,
   excludes unaffordable tiers against `balance - pending`, where pending = drawn-but-unbooked
   spins in the last 24h found by scanning `tournaments`. **No `pending` sub-balance inside the
   reserve**; draw and settle are separate transactions. PARTIAL.
3. Settle `fn_spin_settle_game`: `jackpot_draw` row keyed by tournament; if `prize > available`
   it books `drawn = available`, writes a `SHORTFALL ... covered by operator` adjustment row of
   amount 0, and the engine pays the full prize anyway (`TournamentManagerBase.ts:1776`
   "Players are paid in full regardless") - an unfunded prize, not a refusal. 0 shortfalls in
   24h; the standard says refuse. PARTIAL.
4. **Ledger declaration bug (the 176K/day):** the settle sets `app.ledger_category = 'spin_prize'`
   but leaves the counterparty unset when the entry was already booked (the normal case now), so
   the reserve debit journals as `spin_reserve -> settlement_suspense`.
   24h: **3,303 rows / 185,189.00** `spin_reserve -> settlement_suspense (spin_prize)` vs
   3,305 / 183,965.04 `prize_liability -> spin_reserve (spin_entry)`. Function at fault:
   `fn_spin_settle_game` (add `set_config('app.ledger_counterparty','prize_liability')` +
   entity before the draw UPDATE).
5. `fn_spin_move_owner_wallet` declares `rake` / `overlay` vs `spin_reserve` via
   `fn_ca_declare_ledger` - correct; used only for seed instalments.

### Rake = 8% exactly (24h, `spin_reserve_ledger` contributions)

| spins | collected  | rake booked | 8% of collected | reserve_in | split gap | rake_records rows | dup rake rows per spin |
| ----- | ---------- | ----------- | --------------- | ---------- | --------- | ----------------- | ---------------------- |
| 3,306 | 199,977.00 | 15,998.16   | 15,998.16       | 183,978.84 | 0.00      | 3,306 / 15,998.16 | 0                      |

`tournament_rake_settlements` for spins in 24h: 3,284 rows / 15,979.44 (the rest not yet
completed). Draws: 3,311 / 185,903.00 = prize owed 185,903.00, 0 shortfalls; `tournament_payouts`
183,749.00 across 3,242 spins (69 still running). Rake double-pay: fixed and holding.

### EV vs S16

Live `spin_tier_spec` (identical to `SPIN_TIERS`): denominator 10,000,099, weighted 27,638,000,
**E[m] = 2.763773** vs seats x (1 - rake) = **2.760000**; gap **+0.003773** (0.137% of buy-in,
effective rake 7.874%). Observed 7d mean multiplier 2.7627 over 14,407 draws. Standard asks
|gap| < 1e-4: DOES NOT MEET (P2, by construction). `spin_payout_ladder` places match
`SPIN_TIERS.payouts` (100 / 80-20 / 80-12-8), updated 2026-09-02 17:32.

Reserves: union pool `2d968239` balance 61,259.84 = 10,000 seed + 10,000 merge + 2,231,449.84 in

- 2,190,198.00 draws + 8.00 (exact). Club pool `01810895` 20,297.08 after three undeclared
  mgmt-api resets to 20,000 on 09-01 (873.20 + 115.20 + 873.20 burned to suspense, role postgres).

---

## D. SNG + CASH - grade: MEETS (cash), PARTIAL (SNG cutover)

### SNG

Same path as MTT: `fn_register_for_tournament` -> `fn_settle_tournament_obligation`
(`tournament_obligations` UNIQUE (tournament, kind, place)). The obligation path went live at
**2026-09-02 20:52 UTC**; since then 139 of 165 paid tournaments carry obligations
(86 SNG / 50 spin / 1 freezeout / 1 mystery), 0 unpaid rows. Before that, payouts went straight
to `wallet_transactions`.

24h conservation (escrow shadow, latest run): SNG 361 balanced (prize_in 16,360.90 =
prize_out 16,360.90, fee 861.10 = 861.10), **1 underpaid by 3.80** (a 1.90-buy-in HU SNG with
prize_out 0). Bounty / freezeout / mystery: balanced. Satellite: 1 overpaid -92.00 (Lane G).
`fn_tournament_money_conservation(1, 0.01, 20)`: 3,777 scanned, 21 flagged, 3,650 unfunded chips,
worst 920 - spins dominate (the shadow marks spins `not_asserted`).

### Cash

- Buy-in: `atomic_table_buyin` (engine/HorseFleetManager + World Hub `horse-launch.js`) and
  `fn_take_seat_and_buy_in` (browser). 24h ledger: `buyin` 2,390 + 1,019 (mgmt-api) rows,
  546,675.67; `addon` 53 / 7,967.14 via `resolve_pending_addon` (pending table). The bust rebuy
  `atomic_table_rebuy` (TablePage.tsx:7633) is still a direct `stack += n` (C3 open).
- Cash-out: `atomic_seat_cashout_locked` from `GameServer.ts:2167` and `seats.ts:88,128`;
  `HydraService.ts:676` still calls `atomic_table_cashout` (unkeyed, C1).
- **Seat-exit coverage 24h: 2,518 exits / 526,119.26 chips, `fn_unaccounted_seat_exits('24h','10m')`
  = 0 rows / 0.00.** By writer: 2,504 PostgREST (engine), 14 pg_cron; 0 Supavisor/direct.
- Ledger: `table_cashout` 2,509 rows / 524,425.91; but 9 pg_cron cash-outs (1,693.35) still
  journal as `adjustment` (C5 partly open), and 541 small `table_stack -> player_wallet
adjustment` rows (4,887.00, "auto-audited club_members.chip_balance delta") are undeclared
  wallet credits from PostgREST (2.00/3.00/4.00... - look like unfilled-spin/SNG refunds).

---

## E. RAKE DISTRIBUTION - grade: MEETS (since 2026-09-02 00:46 UTC)

One raked cash hand, live `atomic_distribute_rake`:

1. declares `rake` vs `table_stack`; inserts `rake_records` `ON CONFLICT (hand_id) DO NOTHING`;
2. `rake_attributions` per player (weighted-contributed) - basis for VIP points, agent
   commission (`credit_agent_commission_from_rake` = accrual rows in `agent_commissions`, no
   chips move per hand), rakeback. 6h: 11,224 hands, rake 14,984.50, attributed 14,984.50,
   0 hands unattributed, 0 mismatches;
3. leg `club_accumulator` (amount rake - bbj) - since the 09-02 ruling it moves NO chips
   (`chip_balance = chip_balance`), it only bumps the `club_wallets` counters;
4. leg `union_rake` (union game): `union_wallets.rake_wallet += rake`, or leg `chip_treasury`
   (standalone): `clubs.chip_treasury += rake` with an explicit chip_ledger row.
   BBJ is banked separately by `bbj_record_contribution` and `rake_amount` excludes it
   (`hand_history.rake_amount = rake_records.rake_amount` on 28,722/28,722 hands).

24h per club (cash hands with `hand_id`):

| club                          | hands  | rake      | bbj      | chip-moving leg             | accrual leg | hands with no leg |
| ----------------------------- | ------ | --------- | -------- | --------------------------- | ----------- | ----------------- |
| Deep Stack Society (no union) | 20,623 | 36,894.83 | 3,861.59 | chip_treasury **36,894.83** | 33,033.24   | 0                 |
| Midway Union club             | 8,074  | 12,444.31 | 1,311.60 | union_rake **12,444.31**    | 11,132.71   | 0                 |

`rake_distributed_must_equal_rake_collected`: the live `fn_ca_rake_distribution_mismatch`
excludes `club_accumulator` and asserts `sum(chip-moving legs) <= rake + 0.01`;
`fn_ca_rake_distribution_mismatch_count()` = **0%** (10-min window), 24h mismatches **0**,
ratchet `rake_distributed_exceeds_collected_1h` baseline 0 ("was ~96 while
atomic_distribute_rake banked the rake twice"). The double bank stopped at 00:xx UTC on 09-02
(last `table_stack -> club_wallet rake` journal row 2026-09-02 00:59; 6,223.48 over the preceding 9h).
`club_wallets.chip_balance` still holds the historic double-banked rake:
1,361,553.01 (union) + 1,498,409.06 + 1,488,797.05 (retired clubs) + 4,810.10 - Dan's decision.

`fn_rake_spec_checksum()` = `24f571834759564ce7929c33e50bb983`, `fn_rake_spec_self_check()` 0 rows.

Mirroring: the three rulings that changed `atomic_distribute_rake` / `record_rake` /
`fn_ca_rake_distribution_mismatch` (`20260902004631/004709/004838_*`) and the spin fix
(`20260902150500_*`) exist only on branch `fix/a-correction-is-not-a-mint` (not merged, 0
branches contain it in main). `credit_club_wallet_rake` still credits `club_wallets.chip_balance`
in its live body, has no repo definition (C6), and its only caller `logRakeCollection`
(`rake.ts:20`) is dead code the engine no longer calls. `fn_ca_settle_hand_stacks_absolute`,
`fn_add_chips`, `fn_sweep_bbj_promo_all` also have no repo definition.

---

## Still to build (this lane)

1. `fn_bbj_reconcile()` per pool per bank (main/backup/promo), monthly, variance > 1.00 ->
   incident; snapshot the three balances per pool so a 30-day opening exists; and close the
   73,367.70 lifetime gap (71,749.31 of it = `total_paid_out` counter with no payout rows) with
   Dan's ruling rather than a rebaseline.
2. `bbj_record_contribution`: honour (or explicitly drop) the engine's pivot split; one allocator
   for the live path and the repair path.
3. `bbj_atomic_payout_v2`: declare ledger category/counterparty; journal the seat credit; route
   the seat credit through `table_pending_addons` (C3); alert when backup cannot reseed.
4. `fn_sweep_bbj_promo(_all)`: declare `bbj_promo_sweep` both sides; journal the union
   `promo_wallet` leg; put `clubs.promo_balance` inside `fn_ca_supply_snapshot`.
5. Promo: one issuance function that sets `promo_playthrough_required`; retire
   `redeem_promo_to_chips`, `distribute_promo_chips`, `add_to_promo_wallet` + their three
   front-end callers; make `fn_promo_wallet_send` either a promo grant (locked + playthrough) or
   rename it - today it pays cashable chips; add expiry; a payout path or removal for `promotions.prize_pool`.
6. `fn_spin_settle_game`: set counterparty `prize_liability` (stops 185k/day into suspense);
   reserve the prize inside the pool at draw (`pending` column) and settle from it; refuse or
   fund-from-treasury on shortfall instead of paying an unfunded prize; re-balance 2x/3x so
   E[m] = 2.7600 (or pin the law test at 2.763773 and document the 0.137%).
7. Merge `fix/a-correction-is-not-a-mint` (or re-express its four rake/spin migrations on
   main) so the live bodies have a repo mirror; mirror `credit_club_wallet_rake` and delete
   `logRakeCollection`; mirror the other C6 bodies.
8. Cash: C1 key on `atomic_table_cashout` (HydraService), C3 bust rebuy through the pending
   table, C5 `player_leave_table` / cron cash-outs declare `table_cashout`, identify the 541/day
   undeclared small wallet credits.
9. SNG: the 3.80 unpaid HU SNG; finish the obligation cutover (started 20:52 UTC today).

## Queries run (abridged, all SELECT)

- `pg_get_functiondef` for: fn_effective_bbj_drop, bbj_record_contribution, fn_bbj_reseed_main_from_backup,
  bbj_atomic_payout_v2, bbj_credit_one_recipient, fn_sweep_bbj_promo, fn_sweep_bbj_promo_all,
  fn_bbj_repair_unbanked, fn_rake_bbj_audit, fn_bbj_conservation_check, mint_club_promo,
  add_to_promo_wallet, promo_apply_playthrough, redeem_promo_to_chips, distribute_promo_chips,
  fn_bbj_promo_payout_atomic, fn_promo_wallet_send, transfer_promo_agent_to_player,
  fn_union_distribute_promo, fn_union_fund_promo_from_bank, fn_spin_book_entry,
  fn_spin_draw_multiplier, fn_spin_settle_game, fn_spin_move_owner_wallet, atomic_distribute_rake,
  fn_settle_tournament_rake, fn_ca_rake_distribution_mismatch, credit_club_wallet_rake,
  credit_club_rake_to_treasury, credit_agent_commission_from_rake, fn_ca_supply_snapshot.
- `SELECT * FROM bbj_pools`; `SELECT * FROM bbj_conservation_baseline`; `SELECT * FROM bbj_pool_restorations`.
- Ledger chain per pool/column:
  `WITH r AS (SELECT ..., substring(description from 'bbj_pools\.(\w+) delta') col, pre, post FROM chip_ledger WHERE to_type='bbj_pool' OR from_type='bbj_pool') SELECT pool, col, sum(pre - lag(post)) ...`
- Lifetime per-pool identity: contributions / bbj_payouts / union_wallet_transactions(bbj_promo_sweep, bbj_fund) / chip_transactions(bbj_promo_sweep) / bbj_pool_restorations joined on pool.
- `SELECT fn_bbj_conservation_check(), fn_bbj_gap_decomposition()`; `SELECT * FROM fn_rake_bbj_invariants(24)`.
- 24h rake_records vs bbj_contributions on hand_id; tournament-table contribution checks.
- Promo balances across clubs / union_wallets / agents / club_members / wallets(PROMO) / bbj_pools; chip_transactions + union_wallet_transactions + chip_ledger by promo category.
- `spin_reserve_ledger` 24h by kind; rake*records source fn_spin*\*; tournament_rake_settlements for spins; `spin_tier_spec` EV; `spin_payout_ladder`.
- `ca_seat_stack_exits` 24h + `fn_unaccounted_seat_exits(interval '24 hours', interval '10 minutes')`; chip_ledger table_stack<->player_wallet by category/actor.
- `ca_escrow_shadow_results` latest run by variant; `fn_tournament_money_conservation(1,0.01,20)`; `tournament_obligations` 24h by variant.
- rake_records vs rake_distribution_legs per club 24h; `fn_ca_rake_distribution_mismatch_count()`; `fn_ca_rake_distribution_mismatch('24 hours')`; rake_attributions vs rake 6h; `fn_rake_spec_checksum()`; `fn_rake_spec_self_check()`; club_wallets journal rows by hour.
