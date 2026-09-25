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

`fee_reconciliation`: `tournament_fee_sources_require_reconciliation` and its siblings. `fn_accounting_tournament_fee_net_plan` requires every positive tournament rake record to have a `captured` row in `accounting_tournament_fee_batches` with a matching fingerprint and amount. The cutover instant is the one row in `accounting_tournament_fee_cutover`: `starts_at = 2026-09-17 18:24:02.831517+00`. Read it from the table, not from a migration version.

An earlier draft of this runbook said the fix was "a reconciliation of the pre-cutover records". A second draft said reconciliation was **impossible**, because no club earning terms existed before the cutover. **The second draft was wrong. This paragraph is the correction, and the wrong version was on main from 05:06 to the commit that replaced it.**

The evidence of who paid is complete. Measured across the whole stranded population on 2026-09-18: all 2,673 pre-cutover positive fee records across 649 live tournaments carry exact, unambiguous evidence. The 2,405 non-Spin records match exactly one `tournament_refund_entitlements` row each under the producer's own exactness rule, zero missing and zero ambiguous, and all 268 Spin fees have three contributor keys, three exactly matched paid entries and exactly one immutable reserve row.

The terms are there too, for almost all of them, and this is where the second draft went wrong. `accounting_agreement_history` begins at 2026-09-14 12:09:27+00, which is three days _before_ the cutover, and 2,122 of its 2,237 observations were recorded before 18:24:02, covering all five clubs. Of the stranded records, 2,445 across 608 tournaments were charged while terms for their club already existed; a sample of 200 evaluated through `fn_accounting_earning_contract` at the charge instant produced a complete contract with a real agent chain every single time, at one, two and three tiers. Do not repeat the mistake that produced the second draft, which was to call the contract function on one record, read its refusal, and generalise.

What actually refuses is **provenance, not terms**. `fn_capture_accounting_tournament_fee` refuses when `r.created_at < cutoff`, or when `r.created_at` is not `transaction_timestamp()`, and it separately refuses any contributor whose `charged_at` is before the cutover. `fn_stamp_accounting_tournament_fee` refuses on the same two rules _before_ it can reach its own `legacy_unverified` branch, which is why these records have no batch row at all rather than an unverified one. Those rules say: this fee is captured by its original producer, inside its original transaction. They are correct rules, and nothing satisfies them after the fact. That is the whole problem, and it is a different problem from the one the second draft described.

The genuine exception is small. 228 records across 48 tournaments, holding 349.28 chips, were charged before 2026-09-14 12:09:27, when no terms had been observed for anyone. For those `fn_accounting_terms_at` has nothing to answer with, `accounting_terms_not_observed` is the true and final answer, and `legacy_unverified` is the status the schema already carries for exactly that case.

Deferral is not the way out, and it was closed on purpose. `fn_defer_accounting_tournament_fees` raises `tournament_fee_positive_deferral_retired` for any positive net fee, and its own comment gives the reason: no new positive fee may use deferral to commit banking without complete attribution. Anyone reaching for it is reaching for a door somebody already locked, deliberately.

So the open question is narrow and answerable: what authority may capture a fee after its producer's transaction has ended, using the same evidence the producer would have used. Nothing in the estate has that authority today.

The chips are 5,340.61 across those 649 tournaments, an average of 8.2 each, sitting in each tournament's prize liability with no refunds against any of them; `rake_records` holds zero negative rows for the whole set, so the plan's refund arithmetic is a no-op here and only the capture question stands between these events and settlement. Until that authority exists, the plan refuses with `tournament_fee_sources_require_reconciliation`, `fn_settle_tournament_rake` turns the refusal fatal because its own `v_net` counts the unattributable fees, and the tournaments stay RUNNING with their winners unpaid.

What such an authority has to produce is exact, and short. `fn_accounting_tournament_fee_net_plan` inspects five things about a batch and nothing else: `status = captured`, a matching `tournament_id`, `source_fingerprint` equal to `fn_accounting_tournament_fee_fingerprint(r)`, `rake_amount` equal to the record's, and the sum of that record's `accounting_tournament_fee_sources.rake_credit` equal to the same amount. It never reads `source_manifest`. So a reconciliation that rebuilds the producer's manifest, runs the producer's evidence checks, drops only the two provenance rules, and writes the batch and sources it would have written, satisfies the plan by the system's own standard.

Two smaller facts worth having. Twenty more tournaments hold post-cutover Spin fees stamped `legacy_unverified` with no manifest, because a contributor had registered before the cutover; their batch rows are protected by `accounting_tournament_fee_batches_immutable`, so they cannot be upgraded even if terms were reconstructed, and the plan refuses that status too although the table's own CHECK constraint exempts it from the manifest requirement. And the plan itself returns `payable: false` in every case: what actually pays is `fn_recognize_accounting_tournament_fees`, from `accounting_tournament_fee_sources` rows, of which the pre-cutover records have none.

To count the blocked tournaments:

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
