# TournamentLobbyEmpty

Runbook for `TournamentLobbyEmpty` in `infra/monitoring/tournament-rules.yml`
(group `tournament-health`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/tournament-lobby-empty`, which has
never served anything.

## What it means

```
poker_tournaments_registering == 0 and poker_tournament_metrics_stale_seconds < 600
for: 30m   severity: warning
```

For half an hour no tournament of any kind has been open for registration,
while the collector is fresh, so this is a real empty board and not a stale
reading. The platform schedules continuously and keeps a card published days
ahead; a player looking at the lobby now sees nothing to enter. Measured
2026-09-26 06:45 UTC for scale: 299 REGISTERING.

## What the expression measures

`fn_tournament_metrics`: `registering` is
`count(*) FROM tournaments WHERE status = 'REGISTERING'`, every format
(MTT, SNG, Spin). The staleness term keeps a broken collector from reading as
an empty board; that case is `TournamentMetricsStale`.

## First checks

1. Confirm, and see what the board holds instead, read-only:

   ```sql
   SELECT status, tournament_type, count(*) FROM tournaments
   WHERE created_at > now() - interval '3 days' GROUP BY 1, 2 ORDER BY 1, 2;

   SELECT max(created_at) AS last_created FROM tournaments;
   ```

   Nothing created recently means the spawners stopped or every insert fails.
   Rows created and immediately CANCELLED means a guard refuses them after
   creation.

2. The spawners' own log lines:
   `docker logs --since 1h club-arena-engine 2>&1 | grep -E 'ScheduledTournaments|TournamentRecurring|insert_failed|structure_missing' | tail -40`.
3. Can the platform create a tournament at all? The 2026-09-01 outage was every
   INSERT into `tournaments` failing in a trigger. Reproduce by cloning a live
   row inside one `DO` block that ends in `RAISE EXCEPTION` (CLAUDE.md 11.5
   rule 1); the error names the trigger and nothing commits.
4. Is the engine leading and past boot? `/health.leadership`. The spawners run
   in the leader.
5. Is the platform frozen? `zz_freeze_launch_guard` refuses new entries during
   the :55 break by design; a freeze that did not thaw stops creation
   (`/health.maintenance.phase`).

## Likely causes

- Every tournament INSERT failing in a trigger or constraint.
- The spawners not running (leadership, a crashed loop, a config row that
  resolves to nothing).
- A structure or blind preset that no longer resolves, so each spawn is
  skipped (`ScheduledTournaments.structure_missing`).
- A freeze that did not thaw.

## What not to do

- Do not insert tournaments by hand to fill the lobby. Creation carries
  contracts (prize math, guarantees, blind structure) enforced by triggers on
  purpose.
- Do not disable a trigger to let spawns through.
- Do not probe with DDL on production (CLAUDE.md section 2, rules 3 and 7).

## Where the owning code lives

- Gauge: `server/src/services/TournamentMetrics.ts`, SQL `fn_tournament_metrics`.
- Spawners: `server/src/services/ScheduledTournamentService.ts`,
  `server/src/services/TournamentRecurringService.ts`, started from
  `server/src/GameServer.ts`.
