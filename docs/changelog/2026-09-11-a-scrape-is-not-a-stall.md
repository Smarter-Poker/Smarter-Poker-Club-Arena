# A scrape is not a stall

2026-09-11. `/metrics` on the engine was 590 KB and 7,005 series, and building
it blocked the authoritative event loop for **136 to 502 ms**, every fifteen
seconds. Found while answering a different question: why the main loop sat at
309 ms p50 with its governor shedding at 0.2 while horse decisions queued 520
deep and expired into blind folds.

## Why a bigger box would not have fixed this

The engine was using 196% of the box's 300%, which reads like a machine that
needs more cores. It is not, and this is the part worth writing down: **the
authoritative event loop is one thread.** Node cannot spread it. Adding cores
helps the decision worker and the equity worker, which were both idle (22 ms
loops), and does nothing at all for the thread that runs every turn timer,
every broadcast and every settlement. The only thing that helps that thread is
taking work off it.

Half a second of synchronous string building, three or four times a minute, is
work on that thread. During it no timer fires, no broadcast leaves, and no
horse decision answer is read.

## What was on it

| metric                          | series | who read it per table        |
| ------------------------------- | -----: | ---------------------------- |
| `poker_table_settlement_age_ms` |  1,363 | nobody                       |
| `poker_table_ms_since_progress` |  1,363 | one `max()` in slo-rules.yml |
| `poker_table_dealable_seats`    |  1,363 | nobody                       |
| `poker_table_hands_dealt`       |    804 | nobody                       |
| `poker_table_hands_per_hour`    |    804 | nobody                       |
| `poker_table_timer_utilization` |    804 | nobody                       |

6,501 of 7,005 samples, and every single `poker_table_settlement_age_ms` in the
scrape read **0** because almost no table is ever mid-settlement.

## What it emits now

Every fleet question is answered by a gauge that is **always present**, so no
aggregation depends on a series existing:
`poker_settlement_age_max_ms`, `poker_settlements_in_flight`,
`poker_fleet_table_stall_max_ms`, `poker_fleet_tables_stalled`,
`poker_fleet_dealable_seats`, `poker_fleet_tables_undealable`.

Per-table samples survive for the tables worth naming: a table actually
settling, a table stalled past 30 s (the same floor `poker_blocked_settlements`
uses), a table that cannot deal, and the twenty busiest by hands. All capped
and sorted worst-first, so a truncated list is still the list you wanted, and
`poker_fleet_per_table_samples_total` / `_emitted` /
`poker_fleet_per_table_liveness_samples` say what was left out, because a
reduction nobody can see is the same trap as a check nobody can see
(CLAUDE.md 10.86).

`sp:table_stall:max_ms` now reads the fleet gauge. Reading `max()` over the
surviving per-table series would also be correct, but it would be ABSENT on a
healthy fleet, and an absent SLO is not a healthy one.

## What did not change

`tests/engine/oneSeriesPerMetricName.law.test.ts` is untouched and still
passes: globals appear exactly once, and every line named `poker_table_*` still
carries a `table_id`. The two new fleet counters are deliberately named
`poker_fleet_per_table_*` rather than `poker_table_*` so that law keeps meaning
exactly what it says. `poker_blocked_settlements`, the alarm that matters, is
unchanged.
