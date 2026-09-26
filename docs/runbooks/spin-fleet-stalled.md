# SpinFleetProducingNothing

Runbook for `SpinFleetProducingNothing` in `infra/monitoring/spin-rules.yml`
(group `spin-money`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/spin-fleet-stalled`, which has never
served anything.

## What it means

```
poker_spin_seconds_since_last_start > 1800 and poker_spin_open_boards > 0
for: 5m   severity: critical
```

Spin boards are open for registration and no Spin has started for over half an
hour. Normal cadence is around a hundred Spins an hour. Both halves matter: no
boards open and nothing starting is a quiet room; boards open and nothing
starting is the platform unable to run a game. Every other Spin alert measures
games that exist, so it stays green through this.

## What the expression measures

Two columns of `fn_spin_metrics`: `seconds_since_last_start` is
`now() - max(started_at)` over all Spins (`variant = 'spin'`), and
`open_boards` is the count of Spins in REGISTERING. Measured 2026-09-26 06:45
UTC for scale: 36 seconds since the last start, 127 boards open.

## First checks

1. Confirm from the database, read-only:

   ```sql
   SELECT max(started_at), now() - max(started_at) AS since_last
   FROM tournaments WHERE variant = 'spin';

   SELECT status, count(*) FROM tournaments
   WHERE variant = 'spin' AND created_at > now() - interval '2 hours'
   GROUP BY 1;
   ```

2. Are seats filling? If boards sit at three live seats and never start, the
   start path is failing (step 4). If they sit at zero, players cannot reach
   them (lobby or seating).
   ```sql
   SELECT tournament_id, live_seats, oldest_seat_at FROM v_spin_unfilled_waits
   ORDER BY oldest_seat_at LIMIT 20;
   ```
3. Can the platform create a tournament at all? On 2026-09-01 every INSERT
   into `tournaments` failed for four hours in an AFTER INSERT trigger (a text
   column read as jsonb), and every Spin alert except this one stayed silent.
   Reproduce it by cloning a live row inside one `DO` block that ends in
   `RAISE EXCEPTION` (CLAUDE.md 11.5 rule 1): the error and the trigger that
   raised it come back together and nothing commits. The row-level triggers on
   `tournaments` are listed by
   `SELECT tgname, tgfoid::regproc FROM pg_trigger WHERE tgrelid = 'public.tournaments'::regclass AND NOT tgisinternal;`.
4. The engine log for the start path:
   `docker logs --since 1h club-arena-engine 2>&1 | grep -E 'ScheduledTournaments.insert_failed|spin_launch|SpinDraw|spinLaunchParking' | tail -40`.
   `/health.spinLaunchParks` shows launches the engine has parked and why.
5. Is the platform frozen? During the :55 break the freeze guards
   (`zz_freeze_launch_guard` on `tournaments`) refuse new entries by design;
   a freeze that did not thaw (`/health.maintenance.phase`) stops everything.

## Likely causes

- A trigger or constraint on `tournaments` refusing every insert or start.
- The start path failing its receipt (`fn_spin_draw_and_settle_atomic`
  refusing) so launches park instead of dealing.
- The engine not owning the Spin managers at all (compare
  `poker_tournaments_owned` with `poker_tournaments_running`; see
  `docs/runbooks/tournament-fleet-unserved.md`).
- A platform freeze that did not thaw.

## What not to do

- Do not insert or start Spins by hand, and do not disable a trigger to get
  games flowing; the triggers are money and contract guards.
- Do not probe with DDL on production (CLAUDE.md section 2, rules 3 and 7).
- Do not restart the engine outside the :55 break.

## Where the owning code lives

- Gauge: `server/src/services/SpinMetrics.ts`, SQL `fn_spin_metrics`
  (`live` and `boards` CTEs), added by
  `supabase/migrations/20260902020033_a_fleet_that_produces_nothing_looks_like_a_quiet_night.sql`.
- Board creation: `server/src/services/TournamentRecurringService.ts`.
- Launch and draw: `server/src/tournament/TournamentManagerBase.ts`,
  `spinLaunchParking.ts`, `spinSettlementReceipt.ts`.
- The 2026-09-01 cause and fix:
  `supabase/migrations/20260902013000_every_tournament_insert_was_failing_on_a_text_column_read_as_jsonb.sql`.
