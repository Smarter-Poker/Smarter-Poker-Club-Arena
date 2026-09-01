# The payout sweep covers its window, and a place pays once

2026-09-01. Following #2418 to the end. What I found there was worse than the
truncation, and it was sitting in plain sight inside a return value nobody
reads.

## 1. The applying pass was examining 16% of its own window

`ca-payout-sweep-hourly` ran `fn_tournament_payout_sweep(7, true, 5000)`: a
**seven day** window, and the newest **five thousand** of it. That window
currently holds 31,352 completed tournaments. The pass that actually pays people
reached the newest 5,000 and never looked at the other 26,352 — and it orders
`ended_at DESC`, so a tournament that needed a top-up and then aged out of the
newest 5,000 could never be reached again, by that pass or any later one.

The return value has carried `truncated: true` since 2026-08-29 and nothing read
it. A flag nobody reads is not a safeguard; it is a record of the moment we
stopped noticing.

**The cap was not buying anything.** Measured against production:

```
seconds 13.6 | matched 31352 | scanned 31352 | truncated false
findings 7   | total_top_up 0.00 | failed 0
```

The full seven-day window reconciles in under fourteen seconds, comfortably
inside even the old 120s timeout. The hourly job now scans it whole (40000, the
ceiling the daily detect pass already used) with a 300s timeout — 20x the
measured cost, so a bad day cannot quietly start truncating again.

And truncation now raises a `critical` financial alert instead of returning a
flag into the void. Only on the **applying** pass: a truncated detect run is a
shorter report, but a truncated apply run is a tournament nobody will ever pay.

## 2. Nobody is owed money. Somebody was paid twice.

All seven findings are overpayments — `total_top_up` is 0.00 across the board.
No player is short. But four of the seven are one cent, and three are not:

| tournament                   | excess                      |
| ---------------------------- | --------------------------- |
| Union PKO Afternoon (PLO4)   | **405.00** on a 600.00 pool |
| Sunday $200 Deep Stack, 6th  | **453.60**                  |
| Late Night Grind (PLO4), 3rd | 3.50                        |
| four others, last paid place | 0.01 each                   |

Pulling the PKO one apart: positions 3 through 9 each hold **two** `structure`
rows in `tournament_payouts` — their own prize, plus the prize of the place
above them. A 600.00 pool paid out 1,005.00.

Across the whole table: **30 finishers in 24 tournaments**, 688.30 beyond the
ladder, all of them written between **2026-08-31 13:37:36 and 13:45:12**. Seven
and a half minutes. Nothing before it, nothing after — the 2,780 `structure`
rows written since 2026-09-01 are all singletons.

### What it was not

The attractive theory is an engine restart re-running the completion path, which
would tie this to #2406. It is not that. `hand_history` deals between 35 and 233
hands in **every single minute** from 13:33 to 13:50, unbroken. Whatever ran
twice, the engine never stopped. Recorded because I nearly spent the afternoon
on it.

### Why it was invisible

`fn_tournament_payout_reconcile` saw all of it and filed `overpaid` with the
note _"reported only; automatic clawback is deliberately not done"_ — correct
policy, silent outcome. The finding then sat in the return value of a sweep, in
a list where a 405.00 double-pay and a 0.01 rounding tail are the same shape of
nothing.

`fn_ca_duplicate_structure_payout_check` now runs hourly at :37 and raises a
`critical` alert. Asserted both ways at apply time: silent over the clean six
hours, and it finds all 30 players when pointed at the 08-31 window. A guard
proven only against the healthy case is not proven.

**Not a UNIQUE constraint,** though that would make it impossible rather than
merely visible. A partial unique index refuses writes at the moment a tournament
is paying out, and a legitimate second structure payment — a final-table deal
restated, a re-pay after a correction — would fail closed onto a player
mid-payout. That trade belongs to whoever owns the writer, after auditing every
`source` value. This makes it loud today without risking that.

**The money is not clawed back.** Paid is paid; reversing it is a policy
decision and a money movement, and neither is a guard's to make. Filed for a
human.

## 3. A theory I killed with real data

Four findings are one cent at the last paid place, always on a 513.00 pool. The
reconciler gives every place but the last an independently rounded share and
hands the last place the residual — so it absorbs every rounding error above it.
That looked like an obvious bug, and I was ready to replace it with largest
remainder, the rule `check-chip-conservation.mjs` already holds the JS side to.

Then I ran largest remainder against the actual ladder:

```
pool 51300c  weights [3000,2000,1500,1000,800,600,500,350,250]
largest remainder -> [15390,10260,7695,5130,4104,3078,2565,1796,1282]  sum 51300
```

Place 9 gets 1282 — **12.82, exactly what the reconciler already expects.** Both
9th and 8th land on a .5 fraction, the single leftover cent goes to the better
finish, and 9th keeps 12.82. The payer paid 12.83, and paid 8th its cent too:
513.01 against a 513.00 pool. **The checker is right and the payer is the one
out of step**, minting a cent per tournament of that shape.

So the reconciler is untouched. What did ship is
`fn_ca_largest_remainder_cents(total_cents, weights[])` — the house splitting
rule, in the database for the first time, proven at apply time over 500 fuzzed
cases plus the degenerate inputs. The payer's cent is a separate, tiny, real
defect in someone else's file; it is in the issue, not in this migration.

The lesson is the cheap one: I had a clean theory, a plausible mechanism, and it
was wrong. Fourteen seconds of SQL against production was the difference between
fixing a bug and shipping one into a money path.
