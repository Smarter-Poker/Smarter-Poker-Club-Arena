# An unlinkable BBJ drop is not a missing one

2026-09-07, the last sweep of the BBJ programme. One open warning was left on
the jackpot surface; this is what it turned out to be.

## The alert

`FeeReconciler.bbj_unlinkable`, warning, open since 2026-09-06:

> [A5] 17.98 chips of BBJ contribution over the last 1d sit on 48 `rake_records`
> row(s) with NO `hand_id`, so they can be reconciled against the jackpot pool
> by neither this audit nor `fn_bbj_repair_unbanked`. **Rising numbers here mean
> `logHandHistory` is failing and returning a null id.**

It was rising, sharply: 1 row on 09-04, 2 on 09-05, 24 on 09-06, 47 on 09-07.

## What it actually is

**No jackpot chips are missing.** Measured across all 71 orphan rows of the
preceding two days, carrying 26.18 chips of `bbj_contribution`:

|                                                                                             |                            |
| ------------------------------------------------------------------------------------------- | -------------------------- |
| orphans with a **sibling** `rake_records` row for the same hand that DOES carry a `hand_id` | **71 of 71**               |
| `bbj_contribution` on those siblings                                                        | **26.18** - the same total |
| `bbj_contributions` rows per hand                                                           | **0.99**                   |
| hands banked more than once                                                                 | **0**                      |

The drop reached the pool exactly once per hand. The orphan is a **duplicate
audit row**, not a lost contribution.

`fn_relink_rake_record_to_hand` was probed against five of them inside a
transaction that was rolled back. It returns `0` on every one, and its own first
guard says why:

```sql
if exists (select 1 from public.rake_records where hand_id = p_hand_id) then
  return 0;
end if;
```

The sibling already owns that hand id, so the relink correctly refuses rather
than violating `uq_rake_records_hand_id`. Nothing is broken in the relink.

The duplicate rows are the already-tracked
`chip_standard.duplicate_rake_attribution` incident - 4,452 rows carrying
16,426.46 of `rake_amount` between 2026-04-16 and 2026-09-05. That is somebody
else's open item and this changelog does not take it.

## Why the alert's own sentence had to change

"Rising numbers here mean `logHandHistory` is failing and returning a null id"
is **one of two possible causes and not this one.** It sends an operator hunting
for jackpot chips that never left, on a channel where the whole point is that a
warning means money.

Both causes are real and they need different people:

- **the orphan has a linked sibling** - the drop was banked once and this is a
  duplicate audit row; `chip_standard.duplicate_rake_attribution` owns it;
- **the orphan has no sibling** - `logHandHistory` really is returning a null id
  and a contribution really is unreconcilable.

The alert now says how to tell them apart instead of choosing for the reader
(CLAUDE.md 10.86), and names `fn_bbj_conservation_check` and
`FeeReconciler.bbj_drift` as the two signals that actually say whether chips are
short. Both read clean: `healthy` true, `lifetime_healthy` true, `unexplained`
45.80 and unmoved, and `bbj_drift` is not raised.

The open alert row is resolved with the measurement.
