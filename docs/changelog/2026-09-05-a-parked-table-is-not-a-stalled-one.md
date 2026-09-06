# 2026-09-05 - A parked table is not a stalled one

Branch: `fix/a-parked-table-is-not-a-stalled-one`. The follow-up Dan asked for
after `docs/changelog/2026-09-05-the-deploy-that-cannot-ship.md`, which stopped
the engine from restarting itself on a stall reading but deliberately left the
reading alone.

## The question

That change asked whether one stalled table should kill an engine running 311
healthy ones. It should not, and it no longer does. The question left open was
the one underneath: **why were tables stalling at all?** 1,081 distinct tables -
about a third of the fleet's churn - logged at least one stalled sample in
twelve hours.

## The answer: they mostly were not

`lastProgressAtMs` is a wall clock. It keeps running through every period in
which a table is _deliberately_ not dealing, and nothing ever credits it back.

### 1. The maintenance break, charged to the table the moment it lifts

A parked table is excluded from the stall predicate by `paused`, so the debt is
invisible while it accrues. At :00 the whole fleet stops being paused at once
and every table reappears already carrying the break as "no progress" - not a
climb, a jump.

Measured over 24 hours from Prometheus:

| reading                                            | value                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| the twelve largest stall spikes of the day         | **all** between HH:00:07 and HH:00:37                                                |
| peak                                               | **120 tables at 18:00:22**, as `poker_paused_tables` went 343 -> 0                   |
| share of all stalled table-seconds in minute `:00` | **49.5%**                                                                            |
| share in `:00`-`:03`                               | **55.4%**                                                                            |
| first-observed stall values                        | a hard cluster at **433-446s** - one break plus the in-break restart, arriving whole |

Tracing one table across a break shows it plainly: `d751abf9` read 24s at 17:53,
384s at 17:59, and **6s at 18:00** - it climbed all the way through the break
and reset only when it dealt its first hand afterwards.

This is CLAUDE.md §13 rule 4 - _"Deadlines are thawed, not burned"_ - and the
progress clock is a deadline nobody thought to add to the thaw. What it costs
is not a player's money but the platform's own judgement about whether it is
alive, and on 2026-09-05 that judgement restarted production five times.

### 2. A seat-first tournament, held from dealing and reported as broken for it

`dealHoldUntilMs` holds the first deal under a Spin reveal, and holds a
seat-first tournament between its seats selling and its advertised start.
`isPausedByDesign()` did not know about it, so through that entire window the
table has two or more dealable seats, is not `paused`, and reads as stalled.

Measured, table row created -> tournament `start_time`:

| table      | game                         | gap       |
| ---------- | ---------------------------- | --------- |
| `96e2d84f` | 5 Chip Spin PLO5             | **2287s** |
| `eadb2242` | NLH Heads-Up 50              | **2212s** |
| `d3b1c215` | 50 Chip Deep Stack Spin PLO5 | **3078s** |

Polling `/health` caught two of them mid-"stall": **56 of 56 stalled samples had
a dealing loop that had moved within the last two seconds**, cycling
`spin_reveal_hold -> load_seats -> release_dead_tournament_seats ->
refresh_blinds`, with `handCount` 0 and every seat sold. Not one was wedged.
That population is the whole of the long tail behind "modal stalled count of
one".

### The recovery chain was never broken

Worth stating, because it was the obvious suspect. `ServerTableEngineTurns`
gives a table whose loop is still cycling a free pass until 300s; the stall
gauge fires at 120s. So the metric alarms inside a window the watchdog has
deliberately decided is healthy. Over seven hours of engine log against a
population of 1,081 "stalled" tables: **zero `watchdog_loop_dead`, zero
`killForRestart`, zero rebuilds.** The chain was correctly refusing to rebuild
healthy tables. The reading was wrong, not the response to it.

## The fix

**One line where both resume paths already meet.** `releasePauseGate()` now
calls `markProgress()`. `resumeFromMaintenance()` and `resumeDealing()` both
funnel through it, so the maintenance break and hand-for-hand are covered
together and any third pause authority added later inherits the credit instead
of re-learning this.

**One clause where the question is already asked.** `isPausedByDesign()` -
which exists precisely so "the watchdog and the /health stall detector must
treat this as healthy" - now names `dealHoldUntilMs` alongside the other three
authorities. Compared against `Date.now()`, never `> 0`: the field only ever
extends and is never cleared, so `> 0` would excuse a table forever after its
first Spin reveal, which is the far more expensive failure.

Neither is hiding a stall. Time a table was told not to deal is not time it
failed to deal, and every second of it is already published separately as
`poker_paused_tables`.

## Hardening

`tests/a-parked-table-is-not-a-stalled-one.law.test.ts` (registered in
`docs/laws.d/`) pins: `releasePauseGate` credits the clock; both resume paths
still funnel through it, so the fix cannot quietly become partial; all four
by-design authorities are named; the hold is compared against now and not
against zero; the snapshot publishes `isPausedByDesign()`; and every stall
filter excludes a paused table - the last one because forgetting `!t.paused`
is what produced the hourly `watchdog_kill_rebuild` wave in #2651.

**Run against `origin/main`, 3 of its 6 assertions fail** - one per thing
changed here. The other three pin behaviour that was already correct and is now
load-bearing for this fix.

Its `methodBody` helper is anchored to a declaration rather than the first
match, because the first draft resolved `resumeDealing()` to a CALL SITE and
passed while asserting nothing. That is noted in the file so the next person
does not reintroduce it.

## What this does not claim to fix

A genuine stall still exists and is still reported - now with far less noise
around it. Two known measurement gaps are left deliberately, both recorded here
rather than half-fixed:

- **The gauge fires at 120s while the engine's own floor for a live loop is
  300s.** They should agree, or be two clearly named series. Left alone in this
  change because it moves an alerting threshold rather than fixing a lie.
- **`dealable >= 2` is hard-coded** where the engine already exposes
  `dealThreshold()`. Latent, not active: every cash table on the platform has
  `auto_start_players = 2` (5,486 of 5,486). One config change away from a
  table that is permanently "stalled" by design.
