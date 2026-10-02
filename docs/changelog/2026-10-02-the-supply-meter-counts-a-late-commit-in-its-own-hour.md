# 2026-10-02 - The supply meter counts a late commit in its own hour

Chip-drift launch plan, phase 1 (no silent money failures). Migration
`20261002162528_the_supply_meter_counts_a_late_commit_in_its_own_hour.sql`,
law `tests/the-supply-meter-counts-a-late-commit-in-its-own-hour.law.test.ts`.

## What fired

At 15:05 UTC `fn_ca_supply_snapshot` read **-100,005.30 unexplained**. It raised
critical incidents `2e00634c` (supply meter), `d9ebce90` (kill switch) and
`035e55db` (`financial_alerts:ca_kill_switch`, verdict UNCONFIRMED, so nothing
froze). The trailing-4h figure (-99,991.60) also fails
`scripts/ci/check-chip-conservation.mjs` (|trailing| > 5,000), which refuses
every engine deploy until the reading ages out at 19:05.

## What it was, by transaction

No chip moved without its ledger leg; all 16 stores are in refuse mode.

- Per store, 14:05 -> 15:05, every balance change equals its journal except
  `club_treasury`, which fell 99,700.00 more than its legs.
- Certification club `43731738` was retired by `stale-cert-recovery` in ONE
  transaction that started 14:04:56.07: `club_treasury` 99,700.00,
  `bbj_pool` 100.00 and `spin_reserve` 200.00 -> `chip_retirement`
  (100,000.00).
- `chip_ledger.created_at` is the transaction's start
  (`fn_ca_chip_ledger_enrich`), so the legs say 14:04:56. Their xmin
  (793696749) is 1,644 transactions before the 14:05:15 retirement: the write
  happened around 14:05:1x, after the 14:05:00.18 reading had read the
  balances.
- The 14:05 reading saw the balance and not the legs. The 15:05 reading saw
  the balance gone, and its window is `created_at` in (14:05:00.18,
  15:05:01.72], so the 14:04:56 legs were in neither window. Recounting the
  14:05 window now finds exactly 100,000.00 of burn the reading never saw;
  every window from 07:05 to 13:05 recounts to 0.00 late.

| reading | unexplained | late burn of the window before | corrected |
| ------- | ----------: | -----------------------------: | --------: |
| 14:05   |        0.68 |                           0.00 |      0.68 |
| 15:05   | -100,005.30 |                     100,000.00 |     -5.30 |
| 16:05   |        6.01 |                           0.00 |      6.01 |

This is the same straddle the BBJ epoch already documented
(`20260909101535`); certification churn of 100,000.00 per club made it large
enough to trip the kill switch.

## The two defects and the fix

1. The balances and the ledger window were read in **two statements**, so a
   transaction that committed between them was counted on one side only. The
   meter now reads every balance, its own window, the recount below and the
   range it saw in **one statement** (one MVCC snapshot), with the window
   ceiling (`clock_timestamp()`) evaluated inside it.
2. A transaction that started before a reading and committed after it was in
   **no window**. Each reading now records the range it saw over the last three
   hours (`seen_from`, `seen_mint`, `seen_burn`). The next reading recounts
   exactly that range: whatever is there now and was not then committed late,
   and is counted in the hour it became visible (`late_mint`, `late_burn`).
   `mint_since_prev` / `burn_since_prev` = own window (`window_mint` /
   `window_burn`) + late. A reading from before this change has no `seen_*`
   columns; the first new reading recounts its own window against its stored
   totals, which is the same comparison.

Same stores, same basis (`pending-addon-v4`), same thresholds, same incident
and kill-switch calls. A transaction longer than three hours is still missed,
and is still loud. A deleted ledger row inside the recount range reads as
negative late issuance, which is correct: the journal was altered. Extra cost:
one indexed `created_at` range of three hours (46,861 legs, 5,074 of them
mint/burn, at 16:20).

The 15:05 reading is **recomputed, not set aside**: the true figure is
arithmetic anyone can repeat from the journal, so `unexplained` becomes -5.30,
`late_burn` 100,000.00 and `burn_since_prev` 2,504,581.58. The original value
and the evidence are kept in `ca_supply_snapshot_classifications`
(`late_commit_counted_in_its_own_hour`). The balances are not touched.

## A chip shop refund names where its chips come from

`20261002140203` guarded `fn_credit_chips`: an undeclared caller is refused by
name. `fn_refund_shop_purchase` (World Hub `refund-purchase.js`) called it
undeclared. Each chip purchase retired its price (`chip_debit`, no recipient),
so a refund puts those chips back into circulation: counterparty
`issuance_reserve`, category `refund`, key `ca-shop-refund-<purchase>` (the key
the Diamond branch already uses). The caller's declaration is restored, and
`fn_credit_chips` keeps a category its caller declared. Today every unrefunded
chip purchase was already redeemed, so the door answers `already_redeemed`
first; the branch is fixed rather than left to refuse the first undelivered
item.

## Probes (production, rolled back)

- This file's statements plus a reading: trailing 4h after the recompute 7.36;
  the probe reading -0.84, late 0.00 / 0.00, seen range 13:29 -> 16:29.
- Purchase `128f44bc` (20.00) set back to undelivered: before, the refund
  raised `fn_credit_chips_requires_a_declared_counterparty`; after, success,
  wallet 6,140.02 -> 6,160.02, one leg `issuance_reserve -> player_wallet`
  20.00 `refund` keyed `ca-shop-refund-128f44bc-...`, 0 suspense legs, the
  commit check passed (`SET CONSTRAINTS ALL IMMEDIATE`), and the outer
  declaration was restored.

## Settlement (CLAUDE.md 10.9)

None owed. The 100,000.00 was a certification club's own treasury, BBJ and
Spin seed, retired with its legs. No player was a party.
