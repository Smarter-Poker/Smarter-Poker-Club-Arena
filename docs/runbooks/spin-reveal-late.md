# SpinRevealChronicallyLate

Runbook for `SpinRevealChronicallyLate` in `infra/monitoring/spin-rules.yml`
(group `spin-experience`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/spin-reveal-late`, which has never
served anything.

## What it means

```
poker_spin_reveal_lag_p50_ms > 5000   for: 15m   severity: warning
```

More than half of the Spins started in the last hour reached the draw over five
seconds after the moment the three players were promised the wheel. Each late
Spin is re-anchored so the animation still plays in full (the animation law,
CLAUDE.md 10.6), which is correct, and also means the players sat at a table
waiting for it. Five seconds is the same breach line `v_spin_reveal_latency`
uses.

## What the expression measures

`fn_spin_metrics(60)`: the median of `tournaments.spin_reveal_lag_ms` over
Spins whose `started_at` is in the last 60 minutes and which recorded a lag.
When no Spin started in the window the p50 series is omitted, not zeroed (0 ms
would be a perfect score), so the rule cannot fire on an empty hour;
`poker_spin_reveal_window_spins` says how many Spins the percentile is over.
`poker_spin_reveal_lag_p90_ms`, `_p99_ms`, `_worst_ms` and
`poker_spin_reveal_past_lead_in` (lag over the one-second lead-in) carry the
tail. Measured 2026-09-26 06:45 UTC for scale: 24 Spins, p50 1,590 ms, p90
5,327 ms, 22 of 24 past the lead-in.

## First checks

1. The distribution, read-only:
   ```sql
   SELECT date_trunc('minute', started_at) AS minute, count(*),
          percentile_cont(0.5) WITHIN GROUP (ORDER BY spin_reveal_lag_ms) AS p50,
          max(spin_reveal_lag_ms) AS worst
   FROM tournaments
   WHERE variant = 'spin' AND spin_reveal_lag_ms IS NOT NULL
     AND started_at > now() - interval '2 hours'
   GROUP BY 1 ORDER BY 1 DESC LIMIT 60;
   ```
   A step change at one minute points at a release or a database event; a slow
   climb points at load.
2. Is the engine loop hot? `poker_event_loop_lag_ms`,
   `poker_main_event_loop_governor_scale` and `/health.equityGovernor`. A
   saturated loop delays every await on the start path
   (`docs/runbooks/tournament-scheduler-and-engine-saturation.md`).
3. Is the database slow? The start path is a chain of sequential round trips
   between the third paid seat and `fn_spin_draw_and_settle_atomic`. Time the
   draw's inputs with `EXPLAIN (ANALYZE)` on the reads, not by calling the draw
   (11.5 rule 1).
4. The engine log reports the first overrun after a quiet window at once, then
   summarises: `Tournament.spin_reveal_window_overrun`
   (`server/src/tournament/spinOverrunReporter.ts`).

## Likely causes

- Event-loop saturation in the engine.
- A new sequential read added to the start path in
  `TournamentManagerBase.ts` between the paid gate and the draw.
- Database contention on the rows the draw locks (the tournament and the
  reserve pool); `SettlementLaneConvoy` and `DatabaseDeadlocksElevated` would
  show it.

## What not to do

- Do not shorten or skip the wheel animation to hide the delay (10.6: every
  animation plays in full at the player's chosen speed).
- Do not move the anchor earlier to make the number look better; the lag is
  measured against the promise the players were given.

## Where the owning code lives

- Gauge: `server/src/services/SpinMetrics.ts`, SQL `fn_spin_metrics` (`lag` CTE).
- Start path: `server/src/tournament/TournamentManagerBase.ts` (search for
  `spin_reveal_lag_ms`), `spinRevealWindow.ts`,
  `SpinStartsInOneSecondAndPlaysInFull.test.ts`.
- Overrun reporting: `server/src/tournament/spinOverrunReporter.ts`.
