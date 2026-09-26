# TournamentFleetUnserved

Runbook for `TournamentFleetUnserved` in `infra/monitoring/tournament-rules.yml`
(group `tournament-health`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/tournament-fleet-unserved`, which has
never served anything.

## What it means

```
poker_tournament_fleet_unserved == 1
unless max_over_time(poker_maintenance_break_active[6m]) == 1
for: 10m   severity: critical
```

The leader engine is past its boot grace, holds a fresh database snapshot, and
owns zero tournament managers while the database says tournaments are RUNNING.
Every one of those events is frozen: no hands, no eliminations, no winner paid.
Table liveness looks healthy throughout, because it measures the cash fleet.
On 2026-09-09 this was 120 RUNNING tournaments and 0 owned, with `/health`
saying `liveness: ok`.

## What the expression measures

`TournamentMetrics.toPrometheus` in `server/src/services/TournamentMetrics.ts`
sets the gauge to 1 only when all of these hold: this instance is the leader,
it is not still booting, the tournament snapshot is at most 300 s old
(`FLEET_SNAPSHOT_MAX_AGE_SECONDS`), `running > 0`, and it owns no manager. A
standby, a booting instance and a stale snapshot all report 0 rather than
guess. Ten minutes cannot be reached by the scheduled restart; the break guard
is belt and braces.

## First checks

1. The two halves side by side, from `/metrics` or Prometheus:
   `poker_tournaments_owned` and `poker_tournaments_running`.
2. `/health`:
   ```bash
   curl -s --max-time 10 https://engine.smarter.poker/health | python3 -c '
   import json, sys; d = json.load(sys.stdin)
   for k in ("activeTournaments","tournamentManagersQuarantined","quarantinedTournamentManagers",
             "tournamentResumesInFlight","tournamentResumesFailing","tournamentLease","leadership"):
       print(k, json.dumps(d.get(k))[:300])'
   ```
   A high `tournamentResumesFailing`, a non-empty quarantine list, or
   `tournamentLease.claimErrors` climbing names the stage that refuses.
3. The engine log for the resume pass:
   `docker logs --since 30m club-arena-engine 2>&1 | grep -E 'running_board_read_failed|admission|quarantin|lease' | tail -60`.
   `GameServer.running_board_read_failed` means the RUNNING board could not be
   read completely, and the resume pass refuses to act on an incomplete board.
4. The lease rows, read-only, if the log points at leases. Who holds the
   RUNNING events, and how fresh the heartbeats are:
   ```sql
   SELECT l.instance_id, l.engine_version, count(*),
          max(now() - l.heartbeat_at) AS oldest_heartbeat
   FROM engine_tournament_leases l
   JOIN tournaments t ON t.id = l.tournament_id AND t.status = 'RUNNING'
   GROUP BY 1, 2 ORDER BY 3 DESC;
   ```
   Leases held by an `instance_id` other than `/health.instanceId`, with fresh
   heartbeats, mean another process claims them. The heartbeat protocol is
   described in `docs/runbooks/lease-heartbeat-keyshare-cutover.md`.

## Likely causes

- The RUNNING board read failed (PostgREST row cap, timeout, malformed row).
- Every manager was quarantined or refused admission (lease conflict, an
  abandoned generation, a custody check).
- The resume budget is exhausted by failing resumes
  (`tournamentResumeBudget`, `tournamentResumesFailing`).

## What not to do

- Do not restart the engine outside the :55 break to force re-adoption. It
  voids every cash hand in flight, which is why this gauge is deliberately not
  wired into the liveness verdict.
- Do not change tournament rows or leases by hand to force adoption.
- Do not add a watchdog that restarts on this signal (CLAUDE.md 10.11). Find
  the refusal and fix the line that makes it.

## Where the owning code lives

- Gauge: `server/src/services/TournamentMetrics.ts` (`toPrometheus`), wired in
  `server/src/GameServer.ts`.
- Adoption and resume: `server/src/GameServer.ts` (`discoverTournaments` and the
  RUNNING resume pass), `server/src/tournament/` (`AbandonedGenerationAdoption`,
  `AFencedManagerStandsDown` and neighbouring tests describe the rules).
- Related: `MttFleetNotDealing` and its note in
  `docs/changelog/2026-09-26-board-producers-and-the-fleet-alarm.md`.
