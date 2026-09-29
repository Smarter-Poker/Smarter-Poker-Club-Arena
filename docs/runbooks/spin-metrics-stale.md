# SpinMetricsStale

Runbook for `SpinMetricsStale` in `infra/monitoring/spin-rules.yml` (group
`spin-fairness`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/spin-metrics-stale`, which has never
served anything.

## What it means

```
poker_spin_metrics_stale_seconds > 600   for: 5m   severity: critical
```

Every other rule in `spin-rules.yml` reads a gauge that `SpinMetrics` refreshes
from the database once a minute. A failed refresh deliberately keeps the last
good snapshot rather than zeroing it, because a row of zeroes looks exactly
like perfect health. This gauge is the age of that snapshot. Over ten minutes
means fairness, unpaid prizes, booking gaps and the fleet-liveness pair are all
showing old numbers that look healthy and are not current. A value of 86,400
means the engine has not completed a single read since it booted.

## What the expression measures

`server/src/services/SpinMetrics.ts`: `refresh()` calls
`supabase.rpc('fn_spin_metrics', { p_lag_window_minutes: 60 })` every 60 s.
`stale_seconds` is `now - collectedAt`, emitted even when nothing has ever been
collected. After three consecutive failures the engine reports once, under
`SpinMetrics.refresh_failed`, with the error text.

## First checks

1. The engine log, on engine-01:
   `docker logs --since 30m club-arena-engine 2>&1 | grep -E 'SpinMetrics|fn_spin_metrics' | tail -20`.
   The message carries the PostgREST or Postgres error.
2. Is the engine reading anything? If `TournamentMetricsStale` and
   `HorseFleetMetricsStale` fire at the same time, the cause is shared: the
   database, PostgREST (look for PGRST002 during a schema reload, CLAUDE.md
   section 2), or the engine's event loop (`poker_event_loop_lag_ms`).
3. Time the function itself, read-only (it is `STABLE` and writes nothing):
   ```sql
   EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM fn_spin_metrics(60);
   ```
   `service_role` statements are cut at 8 s. A plan that has crept past that
   fails every call with a statement timeout while every individual view
   still answers when you query it by hand.
4. Grants: `fn_spin_metrics` is granted to `service_role` only. A migration
   that recreated it without the `GRANT` fails every call with a permission
   error:
   ```sql
   SELECT has_function_privilege('service_role', 'public.fn_spin_metrics(integer)', 'EXECUTE');
   ```

## Likely causes

- A statement timeout: one of the CTEs (`fn_spin_unpaid_settlements(24)`,
  `v_tournament_rake_attribution_gaps`, `v_spin_unfilled_waits`,
  `v_spin_reserve_health`) has grown past its index. Fix the query or the
  index; do not raise the timeout.
- A migration changed a column the function or one of its views reads, or
  dropped the grant.
- A PostgREST schema-cache reload loop (PGRST002).
- The engine's event loop is saturated and the call never completes; see
  `docs/runbooks/tournament-scheduler-and-engine-saturation.md`.

## What not to do

- Do not make the collector return zeroes on failure to make the staleness go
  away. That is the defect the fail-closed design exists to prevent.
- Do not probe with DDL (`CREATE OR REPLACE FUNCTION` as a test) against
  production; CLAUDE.md section 2, production DDL policy rules 3 and 7.

## Where the owning code lives

- Collector: `server/src/services/SpinMetrics.ts`.
- SQL: `fn_spin_metrics`, last defined in
  `supabase/migrations/20260902020033_a_fleet_that_produces_nothing_looks_like_a_quiet_night.sql`.
