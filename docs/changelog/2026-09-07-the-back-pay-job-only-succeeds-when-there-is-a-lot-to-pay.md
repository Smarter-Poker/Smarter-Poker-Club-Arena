# The back-pay job only succeeds when there is a lot to pay

**2026-09-07** — measured, not fixed. Filed for the money programme with the
numbers it needs.

Found by reading `financial_alerts` at the end of the Realtime work. **Seven
obligations are open, 436.37 chips are owed, and the oldest is 101 hours old** —
and the hourly job whose entire purpose is to pay them has been failing.

## Who is owed

| user        | tournament             | owed      | paid      | **short**  | age     |
| ----------- | ---------------------- | --------- | --------- | ---------- | ------- |
| `a2bd256e…` | Sunday $200 Deep Stack | 13,441.68 | 13,261.68 | **180.00** | 5.1 h   |
| `05835920…` | Sunday $200 Deep Stack | 8,282.69  | 8,102.69  | **180.00** | 5.7 h   |
| `2e26ae7c…` | PLO4 Heads-Up 25       | 71.25     | 0.00      | **71.25**  | 4.8 h   |
| `0bb5a13b…` | 20 Chip Spin PLO4      | 60.00     | 55.20     | **4.80**   | 16.2 h  |
| `baf4b2c4…` | —                      | 30.12     | 30.00     | **0.12**   | 101.4 h |
| `c3195f0b…` | —                      | 400.00    | 399.91    | **0.09**   | 101.4 h |
| `00000000…` | —                      | 90.36     | 90.25     | **0.11**   | 101.4 h |

The last is a horse. CLAUDE.md 10.5: a horse is paid everything a human is
paid, so it is on this list exactly like the others.

The platform behaved correctly on the way in: the escrow bank was short,
`fn_settle_tournament_obligation` **paid what it held** and recorded the
remainder, and `fn_tournament_payout_reconcile` said plainly that
_"the remaining shortfall needs a human decision"_.

## Why nobody has been paid since

`ca-pay-backed-payout-shortfalls-hourly` runs at :26 every hour and calls
`fn_pay_backed_payout_shortfalls()` under `statement_timeout = '120s'`.
**5 of the last 24 runs failed**, all with:

```
ERROR: canceling statement due to statement timeout
CONTEXT: SQL function "fn_tournament_conservation_delta" statement 1
         PL/pgSQL function fn_pay_backed_payout_shortfalls(boolean,integer) line 10
```

Its driving query is:

```sql
FROM public.tournaments t
WHERE t.status = 'COMPLETED'
  AND NOT (satellite…)
  AND COALESCE(t.variant,'') <> 'spin'
  AND public.fn_tournament_conservation_delta(t.id) > 0.01   -- <<<
ORDER BY t.ended_at ASC NULLS LAST
LIMIT GREATEST(p_limit, 1)
```

`fn_tournament_conservation_delta` is a **SECURITY DEFINER function doing nine
correlated aggregates** — six over `wallet_transactions` (1,218 MB, 2.8 M rows),
plus `rake_records`, `chip_ledger` and two over `tournament_payouts`. Measured
on production just now: **59 ms per call.**

It is called **inside the WHERE clause**, against every COMPLETED tournament.
There are **112,298** of them:

```
112,298 × 59 ms  =  110 minutes,  under a 120-second timeout
```

It is also called a **second time per row** in the SELECT list, so a row that
passes is evaluated twice.

## The part that makes it worse than a slow job

The `LIMIT 500` with `ORDER BY t.ended_at ASC` lets Postgres stop early — but
only **once it has found 500 rows that pass the filter**. So:

- when a lot is owed, it finds its 500 quickly and **succeeds**;
- when little is owed, it walks the whole 112,298-row table and **times out**.

**The job succeeds when there is plenty to pay and fails when there is almost
nothing left.** Which means the residual shortfalls — the last few chips of a
short escrow, the hard cases — are precisely the ones it never reaches. That is
the three 101-hour-old rows above, at 0.12, 0.09 and 0.11 chips: rounding dust
that has survived four days of hourly runs because the pass never gets to them.

## What a fix has to do

1. **Bound the candidate set before the expensive predicate**, not after. The
   obvious bound is the `tournament_obligations` table itself — seven open rows
   against 112,298 tournaments — but note the function's own header explains
   why an earlier exclusion was _removed_: an event can become payable **after**
   its pass, when a guarantee is funded or a baseline acknowledged. Any new
   bound has to keep that true, so this is a design decision for whoever owns
   this path, not a one-line `WHERE`.
2. **Stop computing the delta twice per row.** A lateral join or a CTE gives
   the same answer for half the work.
3. **Make the pass resumable.** A cursor on `ended_at` means each hourly run
   advances the backlog instead of restarting at the beginning and timing out
   in the same place for ever.
4. **The residual amounts still need the human decision** the reconciler asked
   for. The escrow was short — the money to pay these is not in the bank it
   should be in, so somebody has to say where it comes from. That is 10.9's
   "goes to Dan as options with costs", and it is the one part of this no query
   can settle.

## Why I did not settle the 436.37 by hand

10.9 grants the authority and sets five conditions. Condition 1 (**read, not
assumed**) is met — every row above is measured. Condition 2 (**nobody paid
twice**) is where it stops: the escrow is _short_, so paying these means
choosing a source of funds inside escrow machinery I have not read, while the
platform's own designated path exists and is merely broken. Fixing the path is
the root cause (10.11); hand-crediting seven wallets around it is the
compensating write that rule tells you not to reach for.

The same judgement as the stuck tournament earlier tonight, which settled
itself correctly nine minutes after I decided not to race it.

## Filed

- `docs/HANDOFF_CURRENT_STATE.md` section 16 — one P0 row with these numbers
- Every alert above is already open in `financial_alerts`; none was resolved by
  this note, because none of them is fixed
