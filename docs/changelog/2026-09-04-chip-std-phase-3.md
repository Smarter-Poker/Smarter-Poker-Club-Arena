# 2026-09-04 - chip standard Phase 3: one Mint, no negatives, legacy doors closed

**Branch** `fix/chip-std-phase-3`. Three migrations, each applied to production, probed rolled-back first, mirrored byte-exact. Law test `tests/one-mint-no-negatives-doors-closed.law.test.ts`. Every figure below was read from production between 18:20 and 19:05 UTC.

## 3.1 One Mint (`20260904183408_phase_3_1_one_mint_the_register_follows_the_journal`, 18:34 UTC)

**What was true before.** `ca_mint_ledger` held 319 chip rows: two club opening grants (200,000, both certification fixtures since retired) and the 317 restorations of erased seat credits from this morning (41,161.27). The journal held issuance legs the register never saw: 11 opening grants written under the retired `system_mint` name (1,100,000), 15 fixture retirements into `chip_retirement` (1,500,000), five cert-owner wallet reversals into `system_burn` (500,000) and one compensating mint (100,000). `fn_mint_chips_from_diamonds`, the only product door that creates chips (an owner converting diamonds in `ChipMintModal`), declared no counterparty: its next use would have landed in `settlement_suspense` with no register row. `fn_mint_club_chips` was executable by every signed-in browser with no caller in either repo. Register and meter had no relation to each other.

**The structural change: the register follows the journal.** A `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `chip_ledger` fires at commit for every leg whose source is a non-circulating store (a mint) or whose destination is one (a burn), and writes the `ca_mint_ledger` row if the door did not. `fn_ca_mint`, the opening grant and the restoration door write their own linked rows; the trigger sees them at commit and adds nothing (`fn_ca_burn` writes its row without linking the leg, so the trigger adopts a matching unlinked row rather than doubling it). The register therefore cannot be bypassed by any door, present or future, because the journal is the door. Probed rolled-back: `fn_ca_mint` produces exactly one register row; a foreign door (a declared mint with no register write of its own) is registered at commit as `Midway Union`, 77.77; `fn_ca_burn` produces exactly one row; the diamond mint declares `issuance_reserve -> union_bank` keyed `diamond-mint:<op>` and is registered, with nothing in suspense.

**The era backfilled.** 32 legs since 2026-08-31 00:00 UTC (12 mints, 20 burns, listed above) registered from the journal, each linked to its leg, `op_id ledger:<leg id>`.

**The opening baseline.** In one `REPEATABLE READ` snapshot with the supply meter's own `fn_ca_supply_snapshot()`, one labelled row per estate for the chips it holds across every store the meter counts, plus one `circulation` row for stores keyed to no estate and for the register's pre-baseline history, sized so that the register's net equals the meter's total at that instant. At 18:34:08 UTC:

| holder             |        amount |
| ------------------ | ------------: |
| Club JAQK          | 87,961,575.42 |
| SHARK CLUB         | 66,566,781.30 |
| Midway Union       | 28,470,909.15 |
| Deep Stack Society | 10,005,909.40 |
| circulation        |    698,469.51 |

`fn_ca_mint_register_vs_supply()` after apply: register net 193,144,847.90, meter total 193,144,847.90, difference 0.00. From here on the difference is the meter's own unexplained drift and nothing else; the register is complete. The rows say what they are (`OPENING BASELINE, not issuance`); no journal leg was written; no chip moved.

**Doors.** `fn_mint_chips_from_diamonds` now declares the Mint (both branches). `fn_mint_club_chips` revoked from `anon` and `authenticated`. The trigger is created last in the migration: it takes a lock on `chip_ledger` against the engine's ~19,000 writes an hour, and the first attempt with it first deadlocked against a settlement; reordered, it holds the lock for milliseconds before commit.

## 3.2 No negatives (`20260904185104_phase_3_2_a_balance_cannot_go_negative`, 18:51 UTC)

Before: a `>= 0` CHECK existed only on `spin_bonus_pools`, `club_wallets` and `tournament_obligations`; the standard's "player wallets already have it" was wrong. Measured 18:40 UTC: no negative in any balance column, `table_seats.stack` included over all 312,296 rows. 18 constraints added `NOT VALID` then `VALIDATE`d in one transaction: `clubs` (treasury, chip_pool, promo, insurance), `club_members` (chip, promo), `union_wallets` (all six wallets), `agents` (both floats), `table_seats.stack`, `bbj_pools` (three balances). The first attempt at 18:41 deadlocked against live writers (the ADDs take exclusive locks in one order, the settle path takes row locks in another); the second attempt at 18:51 took its locks cleanly (a retry loop with `lock_timeout` 5s, armed to fall back to the 18:55 freeze if it had not). Probed rolled-back: a negative treasury write and a wallet debit below zero are both refused by the constraint.

## 3.3 Legacy doors closed, first cut (`20260904184201_phase_3_3_legacy_money_doors_nobody_calls_are_closed`, 18:42 UTC)

The roadmap gates deletion on measured zero use. The measure that covers every session, the engine's PostgREST pool included, is `pg_stat_statements` (reset 2026-09-02 21:04 UTC, 46 hours). The description-based counts from `chip_ledger` and `ca_direct_balance_writes` only see doors that name themselves; `track_functions` is `none`. For the roadmap's list: **every function had 0 calls in 46 hours** (the only matches were this programme's own probe and migration text).

Closed now, 17 names / 19 overloads, each with no caller in the client, the engine, the World Hub API, another function's body, a cron or a trigger: `atomic_tournament_register`, `atomic_tournament_unregister`, `deduct_chip_balance`, `distribute_chips`, `fn_admin_close_table`, `fn_agent_approve_cashout`, `fn_ca_settle_hand_stacks`, `fn_mint_club_chips` (+ its `_zd3core`), `fn_resolve_bbj_pool`, `fn_tournament_atomic_register`, `fn_tournament_unregister_counter`, `increment_rake_generated` x3, `increment_union_chip_balance`, `mass_fund_horses`, `spin_pool_deposit`, `spin_pool_draw`. EXECUTE revoked from PUBLIC, anon, authenticated and service_role; registry rows `closed`, so `fn_ca_money_rpc_drift` (0 rows after apply) files an incident if any is re-opened. A missed caller fails loudly with permission denied; the GRANT is the rollback. **DROP after seven days of the same silence** is the next cut.

**Left open, with the reason - the roadmap's "World Hub API callers checked (UNVERIFIED)" is now verified:** World Hub routes call `add_chips` (5 routes), `fn_credit_chips` (6), `fn_debit_chips` (3), `record_rake`, `fn_union_close_club_tables_for_join`, `fn_ca_fund_club`, `mint_club_chips`, `mint_club_promo`; the client calls `fn_admin_kick_player`, `fn_leave_seat_and_refund`, `increment_tournament_rake`, `mint_club_chips`; `fn_pay_player_chips` is called by the rakeback payers, `atomic_table_cashout` by `trg_auto_cashout_on_table_close`, `fn_atomic_buyin` by `orb1_buyin_transaction`, `fn_credit_treasury_zd4core` by `fn_credit_treasury`. Each needs its caller re-pointed to the standard path first; the World Hub ones are a World Hub change.

## 3.4 R10 - not done, and why

`REVOKE UPDATE` on the balance columns from every role but the definer owner is gated on 3.3 finishing: today `atomic_table_buyin`, `resolve_pending_addon` and the other approved writers run as the roles that would lose the privilege. R10 lands when the last legacy path is dropped and every writer is a definer function owned by the same owner. Not started, on purpose.

## What the next agent verifies before Phase 4

- `SELECT * FROM fn_ca_mint_register_vs_supply();` - `difference` equals the meter's `unexplained_since_baseline` sum; anything else is a leg that reached a balance without a register row, which the trigger makes impossible, so find the writer.
- `SELECT count(*) FROM fn_ca_money_rpc_drift();` is 0.
- The 17 closed doors: `pg_stat_statements` shows 0 calls since 2026-09-04 18:42; then DROP them, in one migration, with the registry rows kept as history.
