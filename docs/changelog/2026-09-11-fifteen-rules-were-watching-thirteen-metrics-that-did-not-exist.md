# Fifteen Rules Were Watching Thirteen Metrics That Did Not Exist

Before: `alert-rules.yml` and `slo-rules.yml` carried fifteen rules covering settlement failure, the money-alert backlog, the undeclared-trigger register, pg_cron liveness and Open Claw job staleness. Every one of them was written as `metric > threshold`. Thirteen of the metric names they use had never had a single sample — not stale, not zero: no series, across sixty days of retention, ever.

Prometheus does not treat that as an error. `poker_settlement_failure_rate > 0.02` against a metric with no samples evaluates to an empty vector, which is indistinguishable from a condition that is false. The rules loaded. The rules validated. The rules showed green. The rules could not fire.

They were written on 2026-09-04, in response to three incidents that had just happened, and they stayed in that state for seven days.

## What was true while nothing could say so

Read directly out of the database on 2026-09-11, the four conditions below were live:

| Alert                            | Fires at | Actual    | Severity           |
| -------------------------------- | -------- | --------- | ------------------ |
| `UndeclaredTriggerOnAMoneyTable` | > 0      | 73        | critical, SMS page |
| `OpenClawFleetLongSilence`       | > 1 day  | 13.7 days | critical, SMS page |
| `MoneyAlertsGoingUnread`         | > 25     | 693       | warning            |
| `OpenClawJobsHaveGoneSilent`     | > 0      | 16 jobs   | warning            |

The 73 undeclared triggers include 21 on `table_seats` — the table whose unreviewed `BEFORE UPDATE` trigger broke a third of all hand settlements on 2026-09-04. `UndeclaredTriggerOnAMoneyTable` was written that day, because of that trigger, and has never been able to fire.

The sixteen silent Open Claw jobs include all ten `/cron/horse-batch/0..9`, silent between 4.9 and 7.5 days, with no error rows of any kind: they simply stopped being dispatched, which is the exact failure mode `OpenClawJobsHaveGoneSilent` exists to name. The last run of `/cron/horse-batch/0` returned `{"skipped":"engine_disabled","success":true}` — a job reporting success for doing nothing, which the staleness view has no way to distinguish from work.

The other five rules — settlement failure rate, settlement stalls, pg_cron run counts — were quiet for the right reason. Settlement is healthy (0 failures, 1,754 hands settled in five minutes) and pg_cron is healthy (880 runs an hour, 0 failures). That is luck, not coverage.

## The part that makes it a class

Three of the fifteen are `CronMetricsBlind`, `MoneyHealthBlind` and `SettlementMetricsBlind`. They exist specifically to catch "the collector stopped". Each was written as `poker_..._stale_seconds > 600` — which is also an empty vector when the collector never existed. The blindness detector was blind in precisely the case it was built for.

This estate has now hit the same class three times. On 2026-08-15, 27 rules recovered from engine-01 referenced metrics that did not exist. On 2026-09-09, `poker_hands_total` was found to live on a flag-gated registry that is enabled nowhere in this estate, leaving `SLOHandsAreNotBeingDealt` (critical, SMS) structurally unable to fire. And now this.

`check-monitoring-drift.mjs` already guarded the wiring — files loaded, files mounted, receivers that deliver, scrape jobs that still exist. Its header said, in as many words: _Deliberately NOT checked: rule expressions. This guards the wiring._ That line is why the class survived a guard written after the first occurrence.

## Correction

**The producer that was never written.** `server/scripts/collect-monitoring-health.sh` calls one new read-only function, `fn_monitoring_health_snapshot()`, and publishes eleven gauges as a node_exporter textfile — the same mechanism `verify-recovery-stack.sh` has been using all along. A systemd timer runs it every sixty seconds.

It runs outside the engine container deliberately. The engine's own `/metrics` is the shorter path and was the wrong one: a collector that dies with the process it watches cannot report on it, every gauge here describes database state that matters whether or not the engine is up, and the authoritative event loop is single threaded and is the scarcest resource on that box.

It fails closed. On any error it exits non-zero and leaves the previous file untouched, so the embedded collection timestamp ages rather than being replaced by zeros. A collector that cannot read the database must never publish an all-clear it has not earned.

**Staleness is derived, not self-reported.** The three `*_stale_seconds` names are now recording rules over `time() - poker_health_collected_timestamp_seconds`. A collector can only ever write zero for its own age; the moment it stops, a self-reported age freezes at zero and reads as perfectly fresh forever.

**The blindness alerts now catch absence, not only lateness.** `CronMetricsBlind`, `MoneyHealthBlind` and `SettlementMetricsBlind` gain an `or absent(...)` arm, parenthesised so the maintenance suppression covers both arms rather than binding only to the second.

**The maintenance suppression now matches.** These gauges arrive under `job="node_engine01"`, while `poker_maintenance_break_active` comes from `job="engine_game_server"`. A bare `unless` matches on the full label set, so as written it would never have suppressed anything during a break. All nine affected rules use `unless on()`, which is what makes a maintenance break a global fact instead of a per-series one.

**`fn_settlement_health()` no longer reads 4.5 GB to count five minutes.** It took 6,525 ms per call. `ca_settlements` is 4,497 MB over 5.6M rows and its only index on `updated_at` is partial — `WHERE state = 'final'` — so a health check that also counts failed and stuck states fell back to a sequential scan of the whole table. That is survivable by hand and not survivable on a timer, so `idx_ca_settlements_updated_at` is a prerequisite for the collector rather than a tuning nicety. Built `CONCURRENTLY`.

**`v_openclaw_job_staleness` no longer computes its p90 per job.** The correlated subquery scanned the full 30-day gap set once per job, 75 times: 1,179 ms. The same numbers come out of one grouped aggregate in 260 ms. Verified identical before applying: 75 rows each, zero rows in either direction of a two-way `EXCEPT` on every stable column.

**The guard now checks expressions.** `check-monitoring-drift.mjs` gains check 8: every metric name a loaded rule references must have something in `server/src`, `server/scripts` or `infra/monitoring` that emits it, be produced by a `record:` rule, come from a foreign exporter (`node_`, `go_`, `up`, `scrape_`), or hold a line in `infra/monitoring/metrics-without-a-producer.txt` explaining who emits it and why CI cannot see that. A declaration whose metric no longer appears in any rule is also an error, so the exception list cannot become a parking space.

"Produced" is deliberately shallow. It does not prove the emitter is reachable, scraped or correct. It proves that something writes the name, which is the single fact whose absence made all three incidents possible.

The check found its own first false pass: `scripts/ci` was in the haystack, and this module's own header comment mentions `poker_settlement_failure_rate`, so the guard passed itself. `scripts/ci` is now excluded.

## Verification

The static guard and the live database agree on the same thirteen names. Run against the repo with the collector removed, check 8 reports exactly the thirteen, attributed to exactly the fifteen rules. Run against Prometheus, `count_over_time(<metric>[60d])` returns no data for the same thirteen. Neither number was taken from the other.

Two earlier attempts at this census were wrong and were thrown away rather than reported. The first compared two differently-sorted lists with `comm` and produced a false orphan set, caught by sanity-checking a metric known to be referenced. The second matched `poker_act_to_broadcast_ms` inside `poker_act_to_broadcast_ms_bucket` and produced a wrong list of 21 rules. `metricsIn()` strips comments first, then quoted strings, then label matchers, then aggregation label lists, in that order, and the law test asserts all three mistakes stay fixed.

`tests/an-alert-that-names-a-metric-has-something-that-emits-it.law.test.ts`, 8 assertions: every referenced metric has a producer; the thirteen specifically; the three blindness alerts carry `absent()`; the nine revived rules carry `unless on()` and no bare `unless max_over_time`; the collector writes atomically and fails closed; the guard still fails when a producer is taken away; the guard is wired into CI; and the parser is not fooled by comments or label names.

## Not changed

The rules that read engine metrics keep their bare `unless`, because both sides of those comparisons come from the same scrape job and the label match is real. Changing all of them would have been a large diff over rules that work.

`/cron/union-rakeback` (silent 25.5 days, 1 success in 30) and `/cron/rakeback-period-settle` (18.5 days, 2 successes) are not flagged stale and are not fixed here. The staleness view requires five successes in thirty days before it will judge a job, on purpose: it cannot infer a cadence from two data points. That floor is correct and it is also a gap, and the gap is bigger than this change.

The horse-batch and trivia jobs are not restarted here. They belong to the Social product and their schedule lives outside this repo. What changes today is that their silence is now reportable.
