# The alarm could not raise an alarm

**2026-08-31 — Phase 2 follow-up, three defects of my own**

`fn_rake_law_check`, shipped in #2191 as the standing assertion that the rake
taken obeys the rake resolved, could not have logged a single finding. Three
defects, all mine, all caught on its first manual run before pg_cron reached the
job — so nothing was ever written and nothing needed repairing.

1. **It wrote to a generated column.** The INSERT listed `drift`, and
   `ledger_reconcile_log.drift` is `GENERATED ALWAYS AS (stored_balance -
ledger_balance)`. Every call raised `428C9`. The value was right —
   `ledger_balance` carries the rake owed and `stored_balance` the rake taken,
   so the generated drift is already `rake - allowed` — the column just has to
   be left for Postgres to fill.
2. **`entity_type` is a closed vocabulary and `rake_law` was not in it.** The
   CHECK lists the twelve finding types the log knows about. That is a feature:
   it stops a typo inventing a silent thirteenth category nobody greps for. The
   fix is to widen the list once, deliberately, not to drop the constraint.
3. **The severity vocabulary is `('ok','warn','critical')`.** I wrote
   `'warning'`.

There is a symmetry worth stating plainly: the mechanism that refused the first
write is the same one `20260831133000` had just used, in the same PR, to stop
four buy-in columns disagreeing. It works, including on its author. And the
second and third are the lesson this audit keeps re-learning — read the
constraint; do not infer the shape of a table from its column names. I had
queried `information_schema.columns` for `ledger_reconcile_log` and simply not
selected `is_generated`.

## Verified after the fix

`fn_rake_law_check('24 hours')` logged **35 findings on its first run and 0 on
an immediate second run** — both halves of the contract: it sees them, and it
does not double-log.

What it found, live:

| kind                 | severity | hands | chips over | window                                       |
| -------------------- | -------- | ----- | ---------- | -------------------------------------------- |
| `no_flop_no_drop`    | critical | 20    | 9.15       | 2026-08-30 16:45 → 2026-08-31 13:34, ongoing |
| `board_not_recorded` | warn     | 15    | 0.00       | 2026-08-30 16:19 → 2026-08-31 04:46          |

`board_not_recorded` carries no chip overage because the rake on those hands is
correct — it is the hand history that is missing its board. Note that it stops
at 04:46 while `no_flop_no_drop` continues to 13:34: the recording gap may
already have been closed by a deploy overnight, and the rake violation has not.

Both belong to the Phase 3 cash rule guards. Neither is fixed here. What
changed is that they are now counted, classified and timestamped instead of
invisible.
