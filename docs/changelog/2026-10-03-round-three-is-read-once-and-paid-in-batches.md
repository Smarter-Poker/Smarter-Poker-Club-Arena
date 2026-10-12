# Round three is read once and paid in batches (2026-10-03)

## What happened

Every close transaction is capped at 5 minutes (transactions over ~9 minutes during play expire
tournament leases). Round 3 (certified payer -> players, `fn_settle_accounting_rakeback_stage`)
read the book's whole week three times in its paying transaction: the outside clubs' (club,
player) pairs, the week of sources, and every allocation of every certificate. That was 11-52 s,
12 s and 22 s for Midway's week of 2026-09-21 (548k sources), and 80 s for one read of Deep
Stack's week (599k sources). It then paid every period in one loop of ledger writes while holding
every payee's and payer's wallet row. This week is ~3.2x.

## Fix

Migration `20261003162308_round_three_is_read_once_and_paid_in_batches`. It only applies in a
chunked close (job 272); outside one nothing changes.

- **Two-hour windows of sources** (`fn_settle_accounting_rakeback_window`). Each window keeps, per
  (club, player): the source count, the non-house count, and two 60-bit sums of
  `md5(source type|id|rake credit|rake record|agent)`. The read is written per book kind so each
  kind uses its own index. Windows are proved in attempts of their own (at least one per attempt;
  none started 120 s after the attempt began).
- **The certificates, read once** (`fn_settle_accounting_rakeback_plan`). This read covers the
  periods the stage admits, their latest certificates (immutable) and every allocation. For each
  period it keeps the stage's counts and sums, its element-only tests, and the same md5 sums of
  each allocation with the certificate's payer.
- **The paying attempt** still locks the periods (`FOR UPDATE`, original order), reads their
  latest certificates and runs every certificate test live. It uses the kept read
  (`fn_settle_accounting_rakeback_plan_get`) only when every locked (period, certificate, club,
  player) is in it. A period's allocations match its (club, player)'s sources exactly when the md5
  sums agree, given distinct allocations and equal counts, which the stage tests itself. A
  disagreement is the stage's any-bad flag. Items, fingerprint, the duplicate test and every
  refusal are unchanged.
- **Payouts in batches.** An attempt pays in the original order until 90 s after its loop began,
  commits, and returns `batch_committed`. The cascade and the scheduler's standalone branch end
  the attempt as a committed step.
  - A period an earlier batch paid is recognised only by its own evidence: status paid, exactly
    one payout of the owed amount, and its `round3-period:v3:<period>` chip_ledger row with this
    scope, certificate, payout and amount. That idempotency key is unique
    (`ux_chip_ledger_idempotency_key`), so a period can never be paid twice.
  - Anything else still refuses with `legacy_rakeback_payment_requires_reconciliation`.
  - Each batch locks and funding-tests every unpaid period's wallets. On the first batch these are
    exactly the original tests. Each batch also checks every locked wallet against what it paid.
  - The last batch writes the receipt with the round's full amount, payees and periods.

Outside a chunked close nothing changes: no kept read is used, nothing is recognised as paid
earlier, and the loop pays every period in one transaction as before.

## Proof

Two probes, one per book's closed week of 2026-09-21, run as one-shot cron jobs at 2026-10-03
16:55-17:56 UTC. Each installed the migration in its own transaction and rolled everything back.

Each probe ran four steps:

1. It proved the round-3 windows and read the certificates through
   `fn_settle_accounting_rakeback_advance`.
2. It ran the stage in a chunked attempt while the receipt existed. The stage must return that
   receipt as a duplicate.
3. It set the receipt aside, and for Midway also the union's round-3 summary row. The cascade
   writes that row only after the receipt. Both stay in place outside the rolled-back transaction.
4. It ran the stage again over the periods the original close had already paid.

| | Deep Stack Society (club) | Midway Union (union) |
| --- | --- | --- |
| Sources in the windows | 598,992 (84 windows, none failed) | 548,020 (84 windows, none failed) |
| Windows and certificates | 33-72 s (one call) | 32 s (one call) |
| Kept read used by the stage | yes | yes |
| Duplicate call | 0.2 s, returns the receipt unchanged | 3.1 s, returns the receipt unchanged |
| Items fingerprint = receipt fingerprint | `0428a89d…` = `0428a89d…` | `0f94877a…` = `0f94877a…` |
| Periods with any-bad | 0 of 382 | 0 of 598 |
| Batch path: recognised as paid earlier | 382 of 382 | 598 of 598 |
| Batch path: periods left to pay / paid now | 0 / 0 | 0 / 0 |
| Batch path: chip_ledger rows written | 0 | 0 |
| Batch path: receipt written | equal to the original (71,633.44, 382 payees, same fingerprint) | equal to the original (105,621.37, 598 payees, same fingerprint) |

`plpgsql_check` reports the same single temp-table artifact on the stage before and after
(`_rr3_periods_v4 does not exist`), and nothing on the cascade, scheduler, plan or advance.
