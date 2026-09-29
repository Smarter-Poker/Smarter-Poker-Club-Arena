# TournamentNeverStarted

Runbook for `TournamentNeverStarted` in `infra/monitoring/tournament-rules.yml`
(group `tournament-health`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/tournament-never-started`, which has
never served anything.

## What it means

```
poker_tournaments_overdue_start > 0   for: 5m   severity: critical
```

An MTT is still REGISTERING or ANNOUNCED more than ten minutes after its
advertised start time. MTTs start on a clock, so nobody started it, and the
players who registered are waiting for a game that will not begin on its own.
The DEEPSTACK outage in August ran silently for six days in exactly this shape
(a blind preset name that did not resolve).

## What the expression measures

`server/src/services/TournamentMetrics.ts` calls
`fn_tournament_metrics(10, 10, 6)` once a minute. `overdue_start` counts
`tournaments` with `status IN ('REGISTERING','ANNOUNCED')`,
`tournament_type = 'MTT'` and `start_time < now() - 10 minutes`. Seat-first
formats (SNG, Spin) are excluded on purpose; they are counted separately in
`poker_tournaments_seat_first_waiting`, which is informational and not alerted
on. Measured 2026-09-26 06:45 UTC: 1.

## First checks

1. Which events, read-only:
   ```sql
   SELECT id, name, club_id, status, start_time, now() - start_time AS overdue,
          current_players, min_players, max_players
   FROM tournaments
   WHERE status IN ('REGISTERING','ANNOUNCED') AND tournament_type = 'MTT'
     AND start_time < now() - interval '10 minutes'
   ORDER BY start_time;
   ```
2. Why the engine did not start it. The start path is
   `GameServer.discoverTournaments`, which pages every REGISTERING row and
   starts the ones that are due. Read the log for the event id and for the
   known refusals:
   `docker logs --since 1h club-arena-engine 2>&1 | grep -E '<id>|ScheduledTournaments.structure_missing|insert_failed|start_readiness' | tail -40`.
3. Is the start being refused in the database? `trg_tournaments_start_readiness`
   (`fn_guard_tournament_start_readiness`) refuses to start an event that is
   not ready, for example an unfunded guarantee. Reproduce the refusal by
   attempting the start inside one `DO` block that ends in `RAISE EXCEPTION`
   (CLAUDE.md 11.5 rule 1); the error names the guard.
4. Is the engine serving tournaments at all? If `TournamentFleetUnserved` is
   also firing, start with `docs/runbooks/tournament-fleet-unserved.md`.
5. Is the platform frozen? The :55 break freezes starts; a freeze that did not
   thaw holds every event (`/health.maintenance.phase`).

## Likely causes

- The structure or blind preset does not resolve
  (`ScheduledTournaments.structure_missing`).
- A database guard refuses the start (readiness, guarantee affordability,
  blind contract).
- The engine is not admitting tournaments (leadership, lease, quarantine).
- Below `min_players` with no rule for what to do: the event should cancel and
  refund through its own path, not sit.

## What not to do

- Do not flip `status` to RUNNING or CANCELLED by hand. Starting and
  cancelling move money (registration escrow, guarantees, refunds) and go
  through their atomic doors (`atomic_cancel_tournament` refunds).
- Do not disable a trigger to get an event started.
- Do not add a sweep that starts overdue events (CLAUDE.md 10.12); fix the
  reason the start path skipped it.

## Where the owning code lives

- Gauge: `server/src/services/TournamentMetrics.ts`, SQL `fn_tournament_metrics`.
- Start path: `server/src/GameServer.ts` (`discoverTournaments`),
  `server/src/services/ScheduledTournamentService.ts`,
  `server/src/services/TournamentRecurringService.ts`.
- Start guard: `fn_guard_tournament_start_readiness`.
