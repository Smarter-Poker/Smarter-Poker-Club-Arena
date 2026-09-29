# TournamentMetricsStale

Runbook for `TournamentMetricsStale` in `infra/monitoring/tournament-rules.yml`
(group `tournament-health`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/tournament-metrics-stale`, which has
never served anything.

## What it means

```
poker_tournament_metrics_stale_seconds > 600   for: 5m   severity: warning
```

The tournament metrics collector has not completed a refresh for over ten
minutes. A failed refresh deliberately keeps the last good values instead of
zeroing them, so every tournament gauge is frozen at a number that may look
healthy. `TournamentNeverStarted`, `TournamentStuckCompleting`,
`TournamentSeatlessPhantoms`, `TournamentCompletedUnpaid` cannot fire on
anything new, `MttPlayStopped`, `MttFleetNotDealing` and `MttBreakDidNotEnd`
are gated off (`stale_seconds < 300`), and `TournamentFleetUnserved` reports 0
because it refuses to assert from a snapshot older than 300 s. A value of
86,400 means the engine has not completed one read since it booted.

## What the expression measures

`server/src/services/TournamentMetrics.ts`: every 60 s `refresh()` runs two
read-only RPCs in parallel, `fn_tournament_metrics(10, 10, 6)` and
`fn_tournament_progress_metrics(15, 10)`. Both must return a complete, well-formed
row of non-negative integers before a new snapshot is published; anything
missing or malformed keeps the old one. The gauge is `now - collectedAt`. After
three consecutive failures the engine reports once under
`TournamentMetrics.refresh_failed` with the reason.

## First checks

1. The engine log:
   `docker logs --since 30m club-arena-engine 2>&1 | grep -E 'TournamentMetrics|fn_tournament_metrics|fn_tournament_progress_metrics' | tail -20`.
2. Time both functions, read-only (both are `STABLE`):
   ```sql
   EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM fn_tournament_metrics(10, 10, 6);
   EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM fn_tournament_progress_metrics(15, 10);
   ```
   `service_role` statements stop at 8 s. The progress function reads recent
   hands per RUNNING MTT and is the one more likely to grow past that.
3. If `SpinMetricsStale` and `HorseFleetMetricsStale` fire together with this
   one, the cause is shared: database, PostgREST (PGRST002 during a schema
   reload, CLAUDE.md section 2) or the engine event loop
   (`poker_event_loop_lag_ms`).
4. Grants: both functions must stay executable by `service_role`:
   ```sql
   SELECT has_function_privilege('service_role', 'public.fn_tournament_metrics(integer,integer,integer)', 'EXECUTE'),
          has_function_privilege('service_role', 'public.fn_tournament_progress_metrics(integer,integer)', 'EXECUTE');
   ```

## Likely causes

- A statement timeout in one of the two functions (the whole refresh fails if
  either does).
- A migration that changed a returned column's type or name, which the strict
  parser refuses as malformed.
- A dropped grant after a function was recreated.
- Event-loop saturation in the engine.

## What not to do

- Do not relax the parser or zero the gauges on failure. Fail-closed is the
  point: a broken collector must look broken, not healthy.
- Do not raise the service_role statement timeout; fix the query or its index.

## Where the owning code lives

- Collector: `server/src/services/TournamentMetrics.ts`.
- SQL: `fn_tournament_metrics`, `fn_tournament_progress_metrics`.
