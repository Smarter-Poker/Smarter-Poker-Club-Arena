# Tournaments resume with the platform (2026-09-10)

Every hour the whole platform stops for the maintenance break (UTC): :53 last
hand, :55 every table parked and a five-minute countdown, about :57 the engine
restart when there is something to deploy, :00 the thaw and the resume waves.
CLAUDE.md 13, Dan: "EVERYTHING JUST FREEZES, THEN PICKS BACK UP EXACTLY AS IT
WAS" - every table together. Tournament tables came back late.

## What was measured

- First hand after the hour at 16:00 (`hand_history.started_at`): cash p50
  17.0 s, p90 20.2 s; tournaments p50 15.9 s, p90 37.9 s.
- `tournaments.break_started_at` for the 15:55 break: 45 rows from
  15:55:00.002 to 15:55:13.61, a 13.6 s spread. The next break, 16:55: 47 rows
  from 16:55:00.012 to 16:55:18.844, 18.8 s.
- The maintenance break finished its thaw and fired resume wave 0 at
  16:00:07.317 (`engine_maintenance_break_log`, 508 tables). The last wave
  fires 10.5 s after the first.
- The next hour shows it without any mixing: at 17:00 the thaw finished at
  17:00:04.66 (808 tables) and cash tables dealt again from 6.5 s (p50 19.4 s,
  p90 31.9 s), but not one of the 46 tables of events on the 16:55 break dealt
  before 30.7 s (p50 31.7 s, p90 33.7 s, max 36.4 s). Their countdown ran to
  about 17:00:19, and the resumes after it ran one event at a time.

## Why

`GameServer.triggerSynchronizedBreak`, at :55:

1. `await tm.pauseForBreak()` ran for one tournament at a time, about 0.2 to
   0.3 s each, which is the 13.6 s above.
2. Only after that did it set `countdownEndsAt = Date.now() + 5 min` (about
   :00:14), write every countdown one at a time, and arm a timer for that end.
   The timer ran `resumeSynchronizedBreak`, which awaited `resumeFromBreak()`
   one tournament at a time again, so the last events came back well after
   that.

Meanwhile `MaintenanceBreak.end()` ran the thaw, lifted the freeze and resumed
every table in waves. A tournament table ignores its wave until its own
tournament releases it (`resumeFromBreak()` -> `resumeDealing()`), because the
tournament break holds it through `pauseAfterHand`. So every tournament table
waited for a countdown the platform had not agreed to.

## What changed

1. **The tournament countdown ends when the maintenance break ends.**
   `MaintenanceBreak.endsAt()` (new, read-only) answers `breakEndsAt` while
   counting down, `announcedAt + LAST_HAND_LEAD_MS + BREAK_DURATION_MS` during
   the last hand (the tournament break fires at the same :55 instant as the
   countdown and can land on either side of it), and 0 when idle.
   `triggerSynchronizedBreak` reads it once, at the trigger, so nothing after
   it (the pauses, the drain, the countdown writes) can move it:
   `countdownEndsAt = max(that end, now)` with a maintenance break on, and
   `now + 5 min` without one, exactly as before. The window claimed at :55 and
   `remainingBreakMs()` use the same end, so a tournament that starts during
   the drain is held until :00 rather than for the seven-minute worst case, and
   `holdIfBreakIsRunning` hands it the same deadline. The duration passed to
   `beginBreakCountdown` is what is actually left (still exactly five minutes
   without a maintenance break); clients count down to `breakEndsAt` either
   way.

2. **A running tournament comes off its break only after the thaw.** Ending on
   the hour opened a hazard that the late countdown had been hiding.
   `fn_thaw_platform` snapshots its targets at its FIRST call
   (`fn_snapshot_maintenance_thaw_targets`): every RUNNING tournament with
   `on_break = false` has `level_started_at` credited with the frozen seconds.
   A tournament on the break is excluded on purpose, because the engine
   suspended its level clock at :55. If one came off its break before that
   snapshot (`clearPersistedBreak`, then `startBlindTimer` re-persisting
   `level_started_at`), the credit would land on top of a clock that never ran
   through the freeze, and the next engine to adopt the event would hand its
   level a whole break of extra time. The old countdown ended as long after
   the hour as its pause loop had taken, so the resume usually landed after
   the snapshot, by luck.

   `resumeFromBreak()` now waits, for a running tournament, while
   `isMaintenanceFrozen()` is true (from the :53 announcement until `end()` has
   finished the thaw), polling every 250 ms. After the wait it reads `onBreak`
   and the lifecycle token again: another caller may already have resumed it
   (the shared resume timer and an adoption timer can both land at :00), and a
   lifecycle that ended during the wait (a deploy cutover, a lost lease) leaves
   the break and its database flags exactly as they are for the engine that
   adopts the event next. `stop()` drains this very job, so the wait also ends
   within one poll of the fence. Past a 90 s ceiling it reports
   `TournamentManagerBase.resumeFromBreak_thaw_wait_ceiling`, naming the
   tournament, and resumes anyway; every table is still held by its own
   maintenance pause, so nothing is dealt into the freeze. A stopped tournament
   does not wait and only clears its flags, as before. The adoption path in
   `resume()` (the `rebreakTimer`) inherits all of this.

3. **Every tournament is paused, counted down and resumed at once.**
   `pauseForBreak`, `beginBreakCountdown` and `resumeFromBreak` now run
   concurrently (`Promise.all`, a try/catch per manager, the same
   `reportError` tags). The server generation is checked once, after each
   batch has settled, and a fenced server still goes no further; each manager
   already fences its own continuations on its own lifecycle. The resumes had
   to be concurrent: with the thaw wait, one waiting event would otherwise hold
   every event behind it. The pauses and countdown writes no longer decide the
   deadline, but concurrency means `break_started_at`, the Last Hand frame and
   the countdown frame land together for every event, and on an hour with no
   maintenance break (a cancelled announcement) the last of 45 events no longer
   deals 13.6 s after the first has stopped. The cost is about 45 single-row
   updates and 45 Realtime REST sends inside one second instead of across
   fourteen.

Expected effect: a tournament table deals again when its maintenance resume
wave fires, in the same thaw-plus-10.5 s spread as a cash table, instead of
starting about 14 s behind it.

## Tests

- `server/src/SynchronizedBreakDeadline.test.ts`, six new cases: with a
  maintenance break counting down to T every countdown is written with T and
  the resume fires at T however long the pauses took (the old rule ran to
  T + 14 s); without one, the old five minutes from parking; a drain that
  outruns T ends the break at once; a tournament starting during the drain is
  held until T and joins the countdown; every pause is issued in the same tick
  and the generation is checked after they settle; one resume that never
  settles and one that throws hold nobody else. The harness gains a
  `maintenanceBreak` stub (idle by default) and the drain case waits a few
  more microtask turns, because `Promise.all` costs more of them than the
  loop did; its assertions are unchanged.
- `server/src/tournament/ResumeBlindClockBehavior.test.ts`, five new cases on
  the production method source: an adopted break ending at :00 while frozen
  does not clear `on_break`, broadcast, release a table or persist
  `level_started_at` until the freeze lifts, then does, with the level clock
  it had at :55; the ceiling path resumes and reports the tournament; a
  lifecycle that ends during the wait leaves the break alone; two waiting
  resumes take the event off its break once; no wait when not frozen, and a
  stopped tournament still only clears its flags. The harness runs on the real
  constants, read from the source.
- `server/src/tournament/TournamentBreakLifecycleFence.test.ts`, two new cases
  on a real `TournamentManagerBase`: it comes off its break only once the
  freeze lifts, and a fenced manager stops waiting within one poll and writes
  nothing.
- `server/src/maintenance/MaintenanceBreak.test.ts`: `endsAt()` is the
  announced hour through the last hand and the countdown, and 0 when idle.
- Against the old production code, five of the six new `GameServer` cases
  (all but the old-rule one) and both real-manager cases fail, and the new
  harness cases cannot load, because the wait they drive does not exist. With
  only the wait taken out of `resumeFromBreak`, five of the seven new manager
  cases fail; the two that pass pin the no-wait paths and the single resume.
- Existing suites: the maintenance, break, clock and recovery suites under
  `server/src` (22 files, 296 tests), every root test that reads
  `GameServer.ts`, `TournamentManagerBase.ts` or `MaintenanceBreak.ts`
  (including `tests/unit/tournamentRakeAndBreaks.test.ts`,
  `tests/unit/handCompletionLaw.test.ts` and
  `tests/the-break-clocks-agree.law.test.ts`, 42 files, 1003 tests), and
  `tsc --noEmit -p server/tsconfig.json`.

## How to check it on production

The engine only runs this after the publish and the next hourly restart. In
the first hour after that, `tournaments.break_ends_at` for the break should be
exactly `:00:00` (read it during the countdown), and the first hand after the
hour for tables of events that took the break should fall inside the same
spread as cash tables. The first-hand query used above:

```sql
with first_hand as (
  select table_id, (tournament_id is not null) as is_tourney,
         min(started_at) as first_at
  from hand_history
  where started_at >= '<hour>' and started_at < '<hour>'::timestamptz + interval '1 minute'
  group by 1, 2
)
select is_tourney, count(*),
  percentile_cont(0.5) within group (order by extract(epoch from first_at - '<hour>'::timestamptz)) as p50_s,
  percentile_cont(0.9) within group (order by extract(epoch from first_at - '<hour>'::timestamptz)) as p90_s
from first_hand group by 1;
```
