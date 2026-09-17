# Horse fleet settlement

Runbook for the `horse-fleet-settlement` alert group in `infra/monitoring/tournament-rules.yml`. Producer: `server/src/services/HorseFleetMetrics.ts` (one read a minute of `fn_ca_horse_fleet_metrics`) and the `poker_tournament_finish_refusals_total` counter in `server/src/observability/engineInstruments.ts`.

Written 2026-09-17, the day 547 of 835 RUNNING tournaments were decided and unfinished, 547 horses sat in them, and nothing on the scrape said so. Phase 3 of the horse programme; the lane work it measures is `docs/changelog/2026-09-17-sweeps-and-satellites-take-their-own-lanes.md`.

## The question each alert asks

| Alert                                  | Question                                      | First thing to read                                                                                       |
| -------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `TournamentsDecidedButUnfinished`      | How many games are over and not finished?     | `poker_tournament_finish_refusals_total` by reason; `poker_tournaments_decided_unfinished_oldest_minutes` |
| `HorsesCommittedToDecidedGames`        | How much of the fleet is idle in those games? | The same two, then `poker_horses_seated` vs `poker_horses_seated_in_database`                             |
| `TournamentFinishRefusalsPersisting`   | Why did the last finishes fail?               | The `reason` label                                                                                        |
| `TournamentsBlockedByUnreconciledFees` | Are entry fees blocking finishes?             | The accounting batch query below                                                                          |
| `DatabaseDeadlocksElevated`            | Is the database choosing victims?             | The Postgres log, `deadlock detected`, and the functions in each cycle                                    |
| `SettlementLaneConvoy`                 | Is a settlement lane queueing for seconds?    | `poker_settlement_lane_waiters{lane}`; the Postgres log `still waiting for ... advisory lock` lines       |
| `HorseFleetMetricsStale`               | Are the gauges above current?                 | Engine log, `HorseFleetMetrics.refresh_failed`                                                            |

## Decided and unfinished

A RUNNING tournament with at most one player still `playing` has been decided by the cards. What is left is the finish: `fn_complete_tournament_terminal` (places) or the satellite finish, asked for by the elimination scheduler. When that is refused, the manager retries; a refusal a retry cannot cure keeps the tournament RUNNING, its winner unpaid and its horse seated.

To see them:

```sql
SELECT t.id, t.tournament_type, t.updated_at,
       (SELECT count(*) FROM tournament_players tp WHERE tp.tournament_id = t.id AND tp.status = 'playing') AS playing
FROM tournaments t
WHERE t.status = 'RUNNING'
  AND (SELECT count(*) FROM tournament_players tp WHERE tp.tournament_id = t.id AND tp.status = 'playing') <= 1
ORDER BY t.updated_at LIMIT 50;
```

Then the engine log for the reason: `docker logs --since 1h club-arena-engine | grep atomic_finish_refused`. The message names the tournament and the refusal.

## Refusal reasons

`fee_reconciliation`: `tournament_fee_sources_require_reconciliation` and its siblings. `fn_accounting_tournament_fee_net_plan` requires every positive tournament rake record to have a `captured` row in `accounting_tournament_fee_batches` with a matching fingerprint and amount. Records written before the accounting cutover (`20260917181100`, 2026-09-17 18:11 UTC) have no batch and cannot get one through the ordinary path (`fn_stamp_accounting_tournament_fee` refuses records not created in its own transaction). This is the accounting domain's transition gap; the fix is a reconciliation of the pre-cutover records, owned there. To count them:

```sql
SELECT count(DISTINCT rr.tournament_id)
FROM rake_records rr
JOIN tournaments t ON t.id = rr.tournament_id AND t.status = 'RUNNING'
LEFT JOIN accounting_tournament_fee_batches b ON b.rake_record_id = rr.id
WHERE rr.is_tournament AND rr.rake_amount > 0 AND b.status IS DISTINCT FROM 'captured';
```

`rake_attribution`: attribution incomplete for another reason; read `fn_settle_tournament_rake`.

`prize_set`: the prize ladder could not certify a prize (`prize_recalc_record_failed` in the engine log precedes it).

`deadlock`, `timeout`: contention. If `DatabaseDeadlocksElevated` is firing too, that is the cause, not the refusal.

## Deadlocks

`poker_db_deadlocks_total` is `pg_stat_database.deadlocks`, cumulative since the statistics were reset, so read it as a rate. The Postgres log carries the cycle:

```sql
-- Supabase logs (ClickHouse), last 30 minutes, functions in each cycle
select arrayJoin(extractAll(log_attributes['parsed.detail'], '"public"\\."([A-Za-z_0-9]+)"')) as fn, count()
from logs where source = 'postgres_logs' and event_message like '%deadlock detected%'
group by fn order by count() desc;
```

Every cycle is a lock-order difference on a shared row. On 2026-09-17 a change that made the finish take every player's `table_cap` key up front, and the hand obligations take the club wallet before deciding whether they owed anything, produced 1,393 deadlocks in fourteen minutes with the finish, the obligations and `fn_project_hand_side_effects` in every cycle. The fix is the order inside the functions that take the rows. It is never a wider lane and never a lock taken "just in case".

## Settlement lanes

Three advisory lanes, keys in `fn_ca_lock_settlement_lane_*`: G (`ca:tournament-terminal-settlement:v1`) is shared by every hand settlement and taken exclusively only by the two lane helpers; F (`ca:tournament-finish-lane:v1`) is exclusive among finishes, sweeps and satellite finishes; B (`ca:hand-settlement-barrier:v1`) is the hand barrier. `fn_ca_settlement_lane_doctrine()` states the rules and `scripts/ci/check-settlement-lane-doctrine.mjs` asks it on every migration PR.

The gauge samples once a minute, so it catches long convoys only. For the full picture, the Postgres log with `log_lock_waits=on` records every wait over a second: `still waiting for ShareLock on advisory lock [5,4265093629,1253463894,1]` is a G wait; `[5,1162513398,3172327781,1]` is F; `[5,880566413,1926503905,1]` is B.

## When the gauges are stale

The collector keeps its last good snapshot on a failed read and publishes `poker_horse_fleet_metrics_stale_seconds`. Every rule in the group reads `and poker_horse_fleet_metrics_stale_seconds < 600`, so a broken collector silences them and `HorseFleetMetricsStale` says why. Three consecutive failures report once as `HorseFleetMetrics.refresh_failed`. The read is `fn_ca_horse_fleet_metrics(10)`, service_role only, 0.3 s warm through PostgREST.
