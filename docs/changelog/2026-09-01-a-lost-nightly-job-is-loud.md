# A lost nightly job is loud (2026-09-01)

## What was wrong

The league benchmark claimed three days in four and produced nothing, and
nothing on the platform said so.

    horse_league_results  2026-08-29   0 rows   (claim present)
    horse_league_results  2026-08-30   0 rows   (claim present)
    horse_league_results  2026-08-31  33 rows
    horse_league_results  2026-09-01   0 rows   (claim present)

The self-tuner lost 2026-08-30 and 2026-09-01 the same way. Every layer
verdict read off that card during those days rested on one surviving run.

## Why the existing recovery did not fire

`claimNightlyJob` already knew how to take over a dead claim (PR #1881). It
never got the chance. Measured on 2026-09-01:

    04:04  instance A claims 'league', starts the run
    04:10  container replaced (StartedAt 2026-09-01T04:10:42Z) - run dies
           having written zero rows; the first matchup had not finished
    04:12  the replacement boots, finds no rows, asks to claim, and is
           refused: the dead claim is EIGHT MINUTES old, so it is judged
           "still plausibly working"

That refusal was correct. What followed was not: the refused instance latched
its per-process "settled today" flag, so every 10-minute tick for the rest of
the process's life returned immediately -- including every tick after 05:04,
when the claim was finally stale and the takeover would have fired. The
three-hour catch-up window existed precisely for that, and the latch threw it
away.

## The fix

1. **Standing down no longer latches the day** (both AM and PM windows). The
   next tick re-checks, so a corpse is taken over inside the window.
2. **`CLAIM_STALE_MS` 60 -> 30 minutes.** The threshold only bites when the
   claim wrote nothing, and a matchup completes in ~9 minutes at
   `PAIRS_PER_MATCHUP=4000`, so a live run proves itself long before this. An
   hour of grace bought no safety and cost most of the window.
3. **The audit now reports it.** New `fn_audit_nightly_job_health(p_day)`
   emits three findings, wired into `fn_run_horse_daily_audit`:
   - `nightly_job_lost` (critical) - a job claimed the day and its evidence
     table is empty;
   - `league_card_stale` (warn at 1 day, critical at 2+) - catches a
     scheduler that stopped claiming at all, which finding 1 cannot see;
   - `league_matchup_inert` (warn) - `bb100 = 0` with `stderr = 0` over a
     full sample is two identical arms, not a result.

## Proof

Run against the days it was blind to, the new check reports exactly the
outages that happened and stays quiet on the day that worked:

    2026-08-29  critical  league claimed 2026-08-29 and produced nothing
    2026-08-29  critical  league_pm claimed 2026-08-29 and produced nothing
    2026-08-30  critical  league / league_pm / self_tuner - all three
    2026-08-31  warn      v18_squeeze_response returned exactly zero
    2026-09-01  critical  league, self_tuner + league_card_stale

`run_date` was checked against `created_at::date` on every self-tune row of
the last six days before trusting the self_tuner finding: they match, so
those are genuine losses and not a date-offset false positive.

## Notes

- The migration splices the new call into `fn_run_horse_daily_audit` by
  reading `pg_get_functiondef` and re-executing it, rather than retyping
  11.5KB of plpgsql. It asserts the anchor appears exactly once, is
  idempotent, and re-checks all three helper hooks afterwards.
- One transaction, per the production DDL policy: a PostgREST schema reload
  costs ~28s on this database and Postgres coalesces the notifies inside a
  transaction.
- Rollback is pasted at the foot of the migration.
