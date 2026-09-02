# Money-integrity sweep: what was broken, what was measurement, what I left alone

**Date:** 2026-08-30
**Scope:** the four money alarms that were firing in production, plus the two
ERROR-level security lints. Companion to
`2026-08-30-ghost-seats-froze-every-live-tournament.md`.

Three of these turned out to be defects in the CHECKS rather than in the money.
That distinction mattered more than anything else here: an alarm that screams a
false twelve million every night is how a real discrepancy gets ignored.

---

## 1. FIXED — a club treasury going more negative every day

`ledger_reconcile_log`, `entity_type='negative_balance'`, severity critical:

| Aug 27   | Aug 28   | Aug 29   |
| -------- | -------- | -------- |
| 1,202.80 | 4,846.10 | 7,161.10 |

**Cause.** `fn_apply_prize_guarantee` funds the overlay on an advertised
guarantee from the UNION wallet when the club is in a union, falling back to the
club treasury only when the union has no wallet row. For three days it wrote
overlays with `bank_type` NULL and debited the club instead:

```
bank_type   Aug 27   Aug 28   Aug 29   Aug 30
(null)      27 rows  12 rows   1 row    0 rows    total 7,161.10
union       13 rows   0 rows  30 rows  53 rows    healthy
```

The NULL-bank total is EXACTLY the negative balance, and exactly one club is
affected. Since Aug 30 every overlay banks to the union correctly — **the writer
is already fixed**, so this was residual damage, not a live leak.

**No treasury floor was added, deliberately.** Funding an advertised guarantee
into the negative is intended: the function raises a `financial_alerts` critical
rather than refusing, because a room does not welch on a posted guarantee. A
floor would have made the platform fail to pay what it advertised.

**Repair** (`20260830204612`): moved 7,161.10 from the union wallet back to the
club treasury, where these overlays belonged. Chip-neutral — the sum of the two
balances is asserted identical before and after. Both sides carry an audit row,
and the 40 overlay rows are stamped `bank_type='union'` so it cannot run twice.
Result: club treasury 0.00, union wallet 233,371.04, zero clubs negative.

## 2. FIXED — the club_treasury reconciler compared the wrong column

`reconcile_ledger_nightly` reconstructs each club's TREASURY from `chip_ledger`
and compares it against **`clubs.chip_pool`**. The treasury column is
`clubs.chip_treasury`. `chip_pool` is a near-empty legacy column:

| club       | chip_pool | chip_treasury |
| ---------- | --------- | ------------- |
| Club JAQK  | 12,459.07 | 1,051,788.71  |
| SHARK CLUB | 0.00      | 1,376,610.47  |

That is why the nightly figure swung **-110,377 -> 5,159,494 -> 12,425,392** on
consecutive nights. No real economy moves like that — the check was reading a
column nothing writes.

Fixed in `20260830205407` by a single asserted token replacement against the
stored function source (the body is 9,322 chars with exactly ONE `chip_pool`
occurrence; the length delta is asserted at +4) rather than retyping a money
function and risking a transcription error. Verified live: all three clubs now
report `stored_balance` equal to their real `chip_treasury`.

**Severity was deliberately NOT downgraded.** Fixing the column does not make
this check green — `chip_ledger` is not a complete journal of treasury movement,
so even against the right column the reconstruction is far off (Club JAQK
-24.3M vs 1.05M). CLAUDE.md 11.5 already records this exact shape:
`atomic_table_buyin` writes `club_members.chip_balance` directly and was
invisible to reconciliation for the same reason. Silencing the alarm now would
hide a real discrepancy later. **The honest next step is to make every treasury
writer journal to `chip_ledger`** — until then this check measures ledger
COVERAGE, not missing money.

## 3. FIXED — operator telemetry was readable by `anon`

`v_shell_staleness_rate` and `v_shell_reload_lateness` are SECURITY DEFINER
views granted SELECT to `anon` — 2 of the only 3 ERROR-level security lints on
the project (the third, `spatial_ref_sys`, is PostGIS-owned and cannot take RLS).

They expose only aggregate telemetry (day, counts, percentages, worst page age)
— no user, club, hand or balance data — so this is posture, not a leak. Safe to
revoke because **nothing anonymous reads them**: they appear in the codebase only
in a comment in `ShellTelemetryService.ts` describing them as operator
dashboards. `authenticated` keeps its grant. SECURITY DEFINER was left in place
on purpose — flipping to `security_invoker` would silently empty an operator
dashboard rather than fix anything.

## 4. LEFT ALONE ON PURPOSE — the settlement freeze

`fn_union_weekly_rakeback_close_all` fails with `EMERGENCY_PROFIT_DRIFT_LOCK`.
That is not a bug: three `settlement_locks` rows were set **2026-08-26 13:38**
with reason "EMERGENCY: PROFIT DRIFT INVESTIGATION" and no unlock date. It is a
deliberate financial control, and it is working. Lifting it would settle real
money on numbers nobody has reconciled yet, so it stays until item 5 is closed.

## 5. INVESTIGATED, NOT REPAIRED — the BBJ conservation gap

`fn_bbj_conservation_check()` reports `gap 74,294.34` against a baseline of
`2,572.59` (drift 71,721.75, tolerance 1.00). What I established:

- **The inflow accounting is sound.** The checkpoint reconciles against ground
  truth to within 27.56 on 767,495 rows, and the `created_at >= as_of` tail
  boundary double-counts nothing (zero rows sit exactly on it).
- **The current writer is healthy.** Every day for the last week,
  `sum(amount) == sum(main+backup+promo)` exactly, with zero null `pool_id`.
- **41,096.65 of the gap is ancient.** Contribution rows whose portions do not
  sum to their amount exist ONLY between **2026-03-03 and 2026-03-07** (~49,700
  rows). Nothing since. Those chips were recorded as contributed and never
  placed in a bucket.
- The remaining ~33k sits on the payout/sweep side and is not explained by any
  uncounted `tx_type` (the sweeps ARE counted; only a single 0.63
  `bbj_dedupe_reversal` is not).

**Not repaired, and that is the decision, not an omission.** Closing this gap
means either crediting ~74k into the pools or writing it off, and both mint or
destroy real player money on the strength of an inference about March. Rebasing
`bbj_conservation_baseline` to make the alarm green would be worse still — it
would erase the only number that remembers this. The forensics are recorded here
so the investigation the freeze exists for can finish on evidence.

## Correction to the earlier write-up

The companion changelog said `FeeReconciler`'s BBJ alarm "misdiagnoses"
tournament entry fees as `logHandHistory` failures. **That was wrong and is
retracted.** The alarm filters on `bbj_contribution > 0`, so it never counted
the tournament buy-in and rebuy rows; its 146 rows / 68.2 chips match the real
subset almost exactly (`atomic_distribute_rake`, cash, 150 rows / 70.00 chips
over two days). The alarm is accurate. What remains true is the mechanism:
`pendingHands` is an in-memory queue drained on shutdown, so the link is lost
only when the database is unreachable for both the inline insert and the drain.
