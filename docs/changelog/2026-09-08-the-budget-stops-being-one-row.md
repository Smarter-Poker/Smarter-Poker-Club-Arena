# One budget row was serialising every award, and the guard failed open

2026-09-08. `supabase/migrations/20260908123428_the_budget_stops_being_one_row.sql`.

## What was observed

5,860 unresolved `DR7:ledger_write_failed` incidents worth **399,948 diamonds**
across `daily_challenges` and `daily_missions`, every one carrying SQLSTATE
`55P03` - "canceling statement due to lock timeout" - plus 21 deadlocks. The
first is stamped **05:37:01**, the same second the diamond register began
failing for the same reason and was fixed in `the_register_lost_a_movement`.
This was the second writer hit by the same contention, and it was still failing
hours after the first was fixed.

## The cause

`fn_ca_diamond_earn_ledger` opened with

```sql
INSERT INTO diamond_reward_budgets (period, engine, ...) ...
ON CONFLICT (period, engine)
  DO UPDATE SET spent_diamonds = diamond_reward_budgets.spent_diamonds + EXCLUDED.spent_diamonds
```

so **every award of one engine in one month updated one row**, and that row lock
was held until the awarding transaction committed. It is the register's advisory
lock in a different costume: a running total maintained on a path that runs
thousands of times an hour, which therefore serialises everything on that path.

## What it cost, and it is more than a counter

The whole body sits inside one `EXCEPTION WHEN OTHERS`, so a timeout on that
first statement skipped everything after it:

- the budget was not debited - `spent_diamonds` was short by 399,948;
- `diamond_user_daily_awards` was never written, so the **per-user** daily figure
  was short too;
- and **neither rule was evaluated**. `v_refuse` is set inside the block and
  raised outside it, so a failed ledger write does not refuse. It permits.

**That last point is what mattered before 2026-09-14.** On that day
`DR7:engine_over_budget` and `DR7:user_over_daily_cap` flip from `log` to
`refuse`. Under exactly the load that makes the write fail, the guard would not
have refused anything: the failure mode of the cap is to let the award through.
A rule that stops working precisely when it is needed is not a rule, and no test
would have caught it, because at one award a second nothing times out.

## The fix, at the root

Spend stops being a running total. `ca_diamond_engine_spend` takes one INSERT per
award, so two awards never touch the same row and there is nothing to wait
behind. `fn_ca_diamond_engine_spent(period, engine)` reports the frozen
`diamond_reward_budgets.spent_diamonds` **baseline** plus the sum of the new rows

- the same shape as the register, which was seeded from balances rather than by
  replaying history, and for the same reason: replaying what the baseline already
  holds would double it.

`spent_diamonds` is frozen from this migration onward; its comment says so.
`fn_ca_diamond_trial_balance` reads the function, so the report and the rule can
never disagree about what has been spent. The per-user write moved ahead of
everything that could contend.

## The failure stops being quiet

If the ledger write fails while either rule is armed to refuse, the incident is
filed as **critical**, because it then means a guard did not run. The award is
still paid - a player never loses an earned reward because our bookkeeping
stumbled (10.9 rule 3) - and "I could not tell" gets its own severity instead of
being folded into silence (10.86).

## Settled once, from the evidence

5,861 lost awards were inserted as spend rows keyed by the journal id each
incident recorded, and every incident was resolved with what happened.
`journal_id` is UNIQUE, so a replay counts once. Nothing scheduled was created;
if this ever needs doing again the cause came back, and the cause is the thing to
fix (10.12).

## Proved before it was applied

A rolled-back probe pushed two real awards down the live trigger path: two spend
rows appeared, the figure moved by exactly 50, the identity held - and **the
budget row's `xmin` was unchanged**, which is direct proof the row was never
written and therefore nothing could have waited on it.

After applying: report and rule agree exactly (2,312,596), identity `0.00`, zero
unresolved `ledger_write_failed`, zero open critical incidents, and real awards
appending spend rows on the live path.

## What this reveals, for Dan

With the counter no longer short, `daily_missions` has spent **127,305 against a
30,000 budget** this month - not the 74,505 the broken counter showed, and 4.2
times its line. It is the ONLY engine over budget: `daily_challenges` sits at
2,183,501 of 12,000,000. **On 2026-09-14 the flip will refuse every
daily-mission award for the rest of September.** Raising that budget, or
accepting the stop, is a decision about what future events pay, which is Dan's
(10.9) - so the number is stated here and unchanged.

## Not fixed here, and named so it is not missed

`award_diamonds_v2` holds `SELECT ... FOR UPDATE` on `diamond_platform_budget`
for the period - a different table, the same one-hot-row-per-month shape. It
appears in none of tonight's incidents and is not on the claim path, so it was
not changed blind alongside a fix that could be measured.
