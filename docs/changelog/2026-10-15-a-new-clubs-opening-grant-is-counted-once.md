# A new club's opening grant is counted once (phase 1, no silent money failures)

Migration `20261015233029_a_new_clubs_opening_grant_is_counted_once.sql`.

## The 100,000.00 critical on Lightning Internal Pilot

`fn_ca_treasury_positions()` read club `e14bc9f7` (Lightning Internal Pilot,
created 2026-10-12 05:09:48 UTC) as critical: ledger 184,830.64 against stored
84,830.64, opening 100,000, a gap of exactly 100,000.00.

No chip moved without its leg. The check counted one leg twice:

- `fn_seed_new_club_opening_bank` (BEFORE INSERT) gives every new club its
  100,000 opening bank, and `trg_ca_autoledger` (AFTER INSERT) journals it:
  chip_ledger `59a04fd3`, issuance_reserve -> club_treasury, 100,000.00, key
  `club-opening-grant:e14bc9f7-...`, stamped with the insert's time.
- `trg_ca_club_gets_a_baseline` (AFTER INSERT, 2026-09-08) then wrote the
  club's `ca_treasury_baseline` row with `opening_balance = NEW.chip_treasury`
  = 100,000.00 at the same instant.
- Every reader computes opening + ledger flow since the cutover (or
  `taken_at`), so the grant was both the opening and a credit.

The writer assumed an inserted balance has no ledger row. Since 2026-09-03 the
opening grant always has one, and under the ledger invariant a club INSERT with
a non-zero treasury cannot commit without it, so every club created after
2026-09-08 with the grant would have read 100,000.00 critical. Lightning is the
only one so far.

**Fix at the writer.** The baseline opening is now the part of the inserted
balance the ledger does not already hold (inserted balance minus the
treasury's ledger net at that instant). `trg_ca_autoledger` fires first (AFTER
triggers run in name order), so a journaled grant yields opening 0 and
`ledger_at_baseline` 100,000.

**The one wrong row** is corrected to exactly that, guarded on the grant leg
existing at `taken_at`; the migration aborts unless the club then reads `ok`.
Rolled-back probe (23:28 UTC): opening 0, credited 104,950.10, debited
20,119.46, ledger 84,830.64 = stored 84,830.64, 0 critical positions. Not a
rebaseline: no other baseline row and no balance changes.

## Incident 56b271f4 (ledger_invariant.refused)

The refused transaction was migration `20261015053941` (lightning pilot horse
funding), txid 1236445167, `txid_status` aborted: it never applied and was
superseded by `20261015093554`. Unrelated to the 100,000: the refusal was a
1.00 mismatch inside the aborted transaction (balance -11,716.40 vs ledger
-11,717.40), while the 100,000 is the 2026-10-12 opening counted twice by the
check. Closed `verified_remeasured`.

## The two callers #5828 left refusing by name

- **World Hub settle-period union hold (`settlement_hold`).** Already retired
  by World Hub #2090 (2026-10-02): the close takes no second union hold
  (`unionHold = 0`, no `fn_debit_treasury` / `fn_union_credit_wallet` call), and
  no `union_wallet_transactions` row has ever carried `settlement_hold`. The
  union's share is taken per hand and returned through the weekly union close.
  Nothing to build.
- **`fn_charge_place_overpays`** retired (CLAUDE.md 10.12). Its cause, duplicate
  finishing places, is refused by unique index
  `tournament_players_one_finish_position`; the last renumber was 2026-08-28
  18:43, all 296 charges were taken by 2026-09-02 06:31, and the queue has been
  empty since. It now moves nothing and answers `status: '_retired'`; the
  engine's hourly caller in `GameServer.ts` is removed.
