# The stat writer says which path it is on

2026-09-12. Club Arena stats recording + `StatsHealthMonitor`.

## What was reported, and what production actually says

`ClubArenaStatsTriggerGap` raised and resolved 32 times on the night of
2026-09-11, in a sawtooth roughly fifteen minutes wide. The investigation that
followed reached this conclusion:

> The trigger `trg_ca_stats_live_from_hand` returns on its first statement
> because `app.atomic_hand_commit` is on; the intended compensating writer
> `fn_project_hand_side_effects` has ZERO callers, so nothing writes the stat
> row at hand time and only the 15-minute backfill remains; `app.atomic_hand_commit`
> appears nowhere in the repo; and `fn_process_hand_position_stats` is denied
> on every hand.

The first clause is true. **The rest is not**, and the reason is worth writing
down because it will happen again: that work was done in the canonical clone
`~/Documents/club-arena`, which is **732 commits behind `origin/main`** (its
HEAD is `ec745dbb18`, 2026-09-06). In that tree
`server/src/services/supabase/handProjection.ts` does not exist and neither do
the `2026090[89]` migrations. The conclusions are correct readings of a repo
that is six days stale.

Read against `origin/main` and against production on 2026-09-12 05:00-05:25 UTC:

| Claim                                                | What production says                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.atomic_hand_commit` appears nowhere in the repo | It is in `20260908042100_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path.sql` and `20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql`                                                                                                    |
| `fn_project_hand_side_effects` has zero callers      | `server/src/services/supabase/handProjection.ts:343` calls it over RPC, woken by `LISTEN hand_projection_outbox` / Realtime with a safety poll; production grants it `service_role=X/postgres`                                                                                     |
| Nothing writes the stat row at hand time             | `hand_projection_outbox` depth was **0**, then **39 rows, oldest 1.1 s**, while the fleet dealt 1,656 hands in a two-minute window - and **0** of those 1,656 lacked a stat row                                                                                                    |
| Position stats fail on EVERY hand                    | 42 `permission denied` warnings in 24 h against 548,235 hands (0.008%), and all four sampled hand ids **have no row in `hand_history`**: those transactions rolled back. No committed hand has lost its positional aggregates                                                      |
| ~200,000 statless hands in 24 h                      | The per-hour missing share decays monotonically with age (84.9% at 26 h old, 0% for the last 7 h). `ca_hand_player_stat` holds 1,001,535 rows over 1,005 users, max 1,008 per user, **999 of 1,005 users sitting exactly on the 1,000 cap**. Those hands are PRUNED, not unwritten |

So the two changes the brief asked for first would have been regressions:

- **Removing the GUC guard** puts five synchronous `AFTER INSERT` triggers back
  on `hand_history`. That is precisely the 2026-09-07 incident that
  `20260908042100` was written to end: 726 hand inserts cancelled in one
  five-minute window by the stats projections describing them.
- **Deleting the "dead" writer** deletes the function that wrote 548,234 of the
  previous day's 548,235 hands.

Neither was done. Per CLAUDE.md 10.8, deployed code is not a law and a brief is
not a law either; the written rule here is the 0908 migration and its guard
tests, and it wins.

## What the sawtooth actually was, and what is fixed

The alarm read ONE number - `recentHandsWithoutStat`, over hands aged 90 s to
3 m 30 s - and raised whenever it was above zero. Underneath it
`ca_roll_hand_stats_forward` (Open Claw, every 15 minutes) backfills that
window clean for a read or two before it refills. **A 15-minute compensator was
driving a 60-second alarm.** Four defects in the detector, all fixed here:

1. **No hysteresis.** It now needs 5 consecutive breaching reads to raise and 5
   consecutive clean reads to clear. Five reads is five minutes: a third of the
   compensator's period and more than twice the width of its clean phase, so
   the sawtooth cannot resolve the alarm every quarter hour any more.
2. **A count with no denominator.** The summary said "1 recent hand(s) have no
   stat row" for windows that held 1,109, 743, 514 and 393 - identical prose
   for 0.09% and for 100%. It reports the SHARE now, against a 20-hand sample
   floor, with the denominator in the summary and in the labels.
3. **No way to tell the two writers apart.** The monitor now takes the
   `hand_projection_outbox` sample `HandOutboxMetrics` already collects once a
   minute, and the alert says whether the projector is BEHIND, CURRENT, or
   UNKNOWN. An unsampled or stale backlog renders as UNKNOWN, never as clean.
4. **A remediation naming a log line that cannot exist.** The old description
   sent the reader to `"trg_ca_stats_live_from_hand:"` in the Postgres log.
   There are zero such lines in 24 hours and there structurally cannot be any
   on the atomic path: the trigger returns before it can fail. The new text
   names `fn_project_hand_side_effects`, `hand_projection_outbox`, the GUC, and
   the two `/metrics` series that answer the question.

## The migration (NOT applied by its author)

`20260912051956_the_stat_writer_says_which_path_it_is_on.sql`, one transaction:

- `trg_ca_stats_live_from_hand()` - the bypass branch now **says so**, once per
  backend per ten minutes (a session GUC holding an epoch second, regex-guarded
  before the cast, no subtransaction). A per-hand log line is the hot-path cost
  the 0908 migration removed; a silent branch is what made this expensive. The
  `EXCEPTION WHEN OTHERS` handler is untouched: a stat row must never block a
  hand.
- `ca_stats_health()` - adds `liveWriter` (outbox depth, capped at 10,001, plus
  the oldest pending row reached through `hand_projection_outbox_hand_number_key`)
  and `roll` (the `ca_hand_player_stat_state.rolled_ceil` cursor and its lag).
  Measured on production: 76 shared buffer hits, 3.140 ms. Its internal comment
  claiming the trigger writes the stat row "in the same transaction as the
  hand" is corrected; that stopped being true on 2026-09-08.
- `GRANT EXECUTE ON FUNCTION public.fn_process_hand_position_stats(jsonb,jsonb,jsonb)
TO service_role` - the legacy path's `permission denied`. A grant to
  `service_role`, not a new `SECURITY DEFINER` and not a browser role:
  `20260906231557_a_trigger_function_is_not_a_browser_routine` is the ruling
  there and its direction of travel is REVOKE from anon/authenticated. `GRANT`
  does not fire `pgrst_ddl_watch`, so only the two `CREATE OR REPLACE`s and the
  `COMMENT`s cost the ~28 s schema reload - which is why they are in one
  transaction (CLAUDE.md 2).
- A `DO $verify$` block that aborts if the trigger is detached, if it is no
  longer `SECURITY DEFINER`, if `service_role` cannot execute the compensating
  writer, if the grant lands on a browser role, or if `ca_stats_health()` has
  lost any key the engine reads.

**This session was instructed not to apply migrations to production and did
not.** The engine change beside it is correct either way: `roll` and
`liveWriter` are read defensively and their absence renders as UNKNOWN, never
as healthy. `check-migrations-applied.mjs` passes because every object named
already exists; what this changes is bodies and one grant.

## Laws

- **New**: `tests/a-stats-bypass-names-its-writer.law.test.ts`. The GUC is
  declared in this repo and not only in production; a migration that turns the
  bypass on also writes `ca_hand_player_stat` or enqueues the outbox claim a
  writer drains; the chain from `fn_project_hand_side_effects` reaches that
  insert, the player index and the DELETE of its own claim; the engine really
  calls it from `handProjection.ts` and holds EXECUTE on it; the bypass branch
  says so at a bounded rate; the trigger still cannot block a hand.
- **Extended**: `server/src/engine/aDetectorMayNotCryWolf.law.test.ts`. That
  law already says an alarm which fires for a condition that always clears is
  not a strict alarm but a broken one. Four pins added from the stats end
  rather than a second, competing law (CLAUDE.md 10.8).

## Flagged, deliberately not changed

- **`ClubArenaStatsEvCoverage` is honest** and is a separate incident: all-in
  equity capture was ~100% down 07:00-09:00 UTC on 2026-09-11 only, against a
  99.7-99.9% baseline. Different cause, different PR.
- **The 1,000-hands-per-player cap is a product decision for Dan.** It is
  enforced in two places - `ca_prune_hand_player_stat(p_keep => 1000)` and the
  retention block at the end of `ca_roll_hand_stats_forward()` - and at current
  volume it is about four hours of history per player, which is what makes an
  old hand look "statless". Nothing here changes it.
- **Repo/production drift in `fn_project_hand_side_effects`.** Production
  delegates its tail to `fn_project_hand_side_effects_after_post_commit_20260908`;
  the newest definition in `supabase/migrations` still has that work inline
  (`20260908042100`). The behaviour is the same and the new law pins the chain
  rather than the shape, so it survives either arrangement - but the repo does
  not currently contain the delegating body.
