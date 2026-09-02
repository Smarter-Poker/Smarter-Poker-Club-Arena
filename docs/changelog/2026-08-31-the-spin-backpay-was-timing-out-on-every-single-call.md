# The Spin back-pay was timing out on every single call

**2026-08-31 — found while making the Phase 1 fairness gauge fit inside a scrape**

## What was wrong

`fn_backpay_spin_unpaid_winners` is the safety net under the one Spin failure
that matters most: a prize **leaves the reserve pool and reaches nobody**.
Fifty-two events had already diverged when it was built. Spin is excluded from
`fn_tournament_money_conservation` entirely, so nothing else on the platform
was ever going to notice.

It had not been running. Called through PostgREST exactly the way `GameServer`
calls it, five times in a row:

```
57014 canceling statement due to statement timeout   8.92s
57014 canceling statement due to statement timeout   8.62s
57014 canceling statement due to statement timeout   8.87s
57014 canceling statement due to statement timeout   9.20s
57014 canceling statement due to statement timeout   9.48s
```

against a `service_role` `statement_timeout` of 8 seconds. The engine calls it
every ten minutes and had been getting an error every time.

Nothing reported it, and nothing could have: **a back-pay that finds nothing
and a back-pay that never runs return the same silence.** It was found only
because building `fn_spin_metrics` meant calling these RPCs the way the engine
calls them rather than the way they were written, and the same view turned out
to be underneath both.

## Why it was that expensive

`v_spin_unpaid_settlements` groups the entire `spin_reserve_ledger`, every
prize credit in `wallet_transactions` (2.5M rows, 979 MB) and every row of
`tournament_players` (198k) before filtering down to a handful. It measured
**10.5 seconds**. And the function read it **three times** per call —
`owed_before`, the loop, `owed_after`.

## The fix, in two parts

**Two covering indexes**, built `CONCURRENTLY` because `wallet_transactions` is
the shared money receipt table and this must not block a buy-in:
`idx_wallet_tx_prize_credits_by_entity` and `idx_spin_reserve_ledger_draws`.
The planner had been reaching prize credits through an index keyed on
`(user_id, created_at)` and discarding 267,000 rows per worker to keep 32,000.
The view went **10.5s → 2.4s**.

That alone was not enough, because three reads of 2.4s still do not fit.

**A window the repair can finish.** `fn_spin_unpaid_settlements(p_since_hours)`
returns the same `ranked_but_unpaid` rows with the same predicate and the same
verdicts, driven from an indexed scan of recent spins and _staged_ so the
seat-shape lookup — the most expensive of the three per-spin reads — is paid
only for spins that are actually short. The recurring repair sweeps six hours,
which is thirty-six passes of its own ten-minute loop; an audit passes a large
window. Equivalence checked against the view over the full history: both
return the same rows.

The unbounded view is untouched and remains the right tool for a human
auditing history.

The second measurement was **not** removed and is **not** derived from the
first. "The backlog itself must shrink; a count of rows processed proves
nothing" is exactly right, and it has to be a genuinely fresh read.

**Result: 5 of 5 calls succeed** where 5 of 5 failed.

## The same shape, twice more

- `fn_spin_metrics` counted the unbounded view too, and failed intermittently
  (1 in 3) at the same limit. It now asks `fn_spin_unpaid_settlements(24)` — a
  window deliberately wider than the six hours the repair sweeps, so the gauge
  can still see anything the repair failed to fix. 6 of 6 calls succeed.
- `v_spin_draw_fairness` joined a `VALUES` list of windows to `tournaments`,
  which turned the time bound into a join filter no index can serve: 7.4s and
  a full scan, three times over. One pass with `FILTER` aggregates, bounded by
  the widest window and served by a new partial index: **1.3s**.

## What this says about the class

Three of the four things measured this afternoon were slow enough to fail, and
none of them were failing _visibly_. The lesson is in how it was found: an RPC
verified in the SQL editor runs as `postgres` with no statement timeout, and
an RPC called by the engine runs as `service_role` with eight seconds. Those
are different tests, and only the second one is the one that matters.

## Tests

`server/src/services/spinRepairsCanFinish.law.test.ts` — 5 pins holding the
source-level half of the contract: every recurring repair the engine drives
passes a bound, the back-pay's window is generous against its own loop but is
not an audit, and the rake-attribution back-pay runs on the loop rather than
only by hand.
