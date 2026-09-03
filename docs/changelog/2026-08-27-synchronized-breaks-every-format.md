# Synchronized breaks: every MTT, Spin and Heads-Up, and a park that is reachable

**Date:** 2026-08-27
**Trigger:** Dan, binding — "DO A DEEP DIVE AND AUDIT INTO THE SYNCHRONIZED BREAKS FOR
EVERY MTT, SPIN AND HEADS UP... THEY SHOULD START AT THE :55 OF THE HOUR EVERY HOUR...
AT THE :55 BREAK HAS STARTED, AND ALL HANDS FINISH, ONCE A TABLE HAS FINISHED THE HAND,
THEY STOP, AND DON'T RESTART UNTIL THE BREAK IS OVER."

---

## What was measured, before anything was changed

`hand_history` joined to `tables` and `tournaments`, production, 48 hours, bucketed by
minute-of-hour. The break window is :55 to :00, so a working break shows a spike at :55
(the last hand landing) and then near-silence.

| tournament_type | :55  | :56  | :57  | :58  | :59  | deep in break (:57-:59) |
| --------------- | ---- | ---- | ---- | ---- | ---- | ----------------------- |
| SPIN            | 4608 | 4529 | 4445 | 4186 | 4658 | **13,289**              |
| SNG (Heads-Up)  | 3961 | 3875 | 3872 | 3966 | 4343 | **12,181**              |
| MTT             | 365  | 54   | 21   | 34   | 33   | 88                      |

The MTT row is what a working break looks like: a spike at :55 as the last hands land,
then it falls off a cliff. The SPIN and SNG rows are flat. **They were not breaking at
all** — 25,470 hands dealt inside break windows in two days.

The MTT row is also not zero, and it should be. Those 88 hands are the second bug below.

---

## Bug 1 (critical) — Spin and Heads-Up were excluded from the break by design

`GameServer.triggerSynchronizedBreak` gated the break on
`tm.isMttOrXmtt() && tm.synchronizedBreaksEnabled()`, and `isMttOrXmtt()`'s entire job is:

```ts
if (type === 'SNG' || type === 'SPIN' || variant === 'sng' || variant === 'spin') return false;
```

Heads-Up has no type or variant of its own on this platform. It is stored as
`tournament_type='SNG'` + `variant='sng'` + `max_players=2` —
`TournamentRecurringService.SNG_BOARD_SHAPES` is a single 2-seat shape, and
`TournamentService` says so in a comment: _"sng: Heads Up (starts when full). 'sng' stays
the stored value; Heads Up is what a player reads."_

So that one predicate excluded **all three** of the formats Dan named except MTT: the
entire 33-board Spin fleet and the entire 16-board Heads-Up fleet.

Worth stating plainly, because it is the thing that made this invisible: **not one
tournament row had opted out.** `synchronized_breaks` is `true` on every Spin and every
Heads-Up in the database (it is the column default, and none of `createSpin`, `createSNG`
or `HorseOrchestrator` writes it). The exclusion was entirely in the format predicate.

### Fix

New single gate, `TournamentManagerBase.takesSynchronizedBreaks()`, which **does not read
the format at all**:

```ts
takesSynchronizedBreaks(): boolean {
  return this.synchronizedBreaksEnabled();
}
```

`triggerSynchronizedBreak` and `holdIfBreakIsRunning` both use it. The only opt-out left
is the explicit per-tournament `synchronized_breaks` column, which an operator sets on
purpose. "Synchronized" is a platform-wide property — its value is destroyed by any
exception, and a format-shaped carve-out is exactly how the last one got in.

Nothing else needed changing to admit them: `pauseForBreak`, `beginBreakCountdown`,
`suspendLevelClock` and `resumeFromBreak` are all format-agnostic, every Spin and SNG
already runs through the same `TournamentManager` (GameServer has one constructor call
site per path, no alternate manager), and the client mounts `TournamentBreakScreen` for
any tournament table.

`isMttOrXmtt()` survives as a genuine multi-table predicate, no longer wired to breaks,
and is now **case-insensitive**. It was the only format check in the codebase comparing
raw column values; migration `20260820_spin_no_fee_constraint.sql` records a real prior
incident where a creation path wrote `variant: 'SPIN'` uppercase and slipped past exactly
this shape of test.

---

## Bug 2 (critical) — the park was unreachable from every idle branch

Dan's rule has two halves: hands in progress finish, and **no table restarts until the
break is over**. The second half was broken.

The park lived inline in `dealingLoop`, immediately after `await this.dealHand(...)`.
That is the one point in the loop a table only reaches when it actually dealt a hand, and
every guard above it leaves the iteration with `continue`:

- `activePlayers.length < minPlayersToDeal()` (sleep 3s, continue)
- the spin-reveal hold (sleep <=1s, continue)
- the mystery-bounty reveal gate (sleep 250ms, continue)
- the admin-pause / maintenance lock (sleep 3s, continue)

and the start-up wait loop hands control to the dealing loop **below** it entirely.

So a table that was not mid-hand at :55 — one short a player while the balancer moves
somebody in, one holding for a spin wheel, one that had just filled — never parked. Two
consequences, both wrong:

1. `isWaitingForHandForHand()` stayed false, so `areAllTablesParked()` stayed false, so
   the platform burned the whole `LAST_HAND_GRACE_MS` (2 minutes) waiting for a table
   that had no hand in the air at all, and logged _"last hand did not land within 120s"_.
   Every such break started two minutes late and ran two minutes past the hour.
2. Worse: the instant that table got its players back — a balanced seat arriving, a wheel
   finishing — it went **straight to `dealHand()` in the middle of the break** and played
   a full hand before parking. Those are the 88 MTT hands at :57-:59 in the table above.

### Fix

The park is extracted to `ServerTableEngineBase.awaitPauseGate()` and the dealing loop
awaits it at the **top** of every iteration, before all of those branches and before the
deal — as well as immediately after a hand lands, so hand-for-hand still parks promptly
rather than after the showdown display pause.

A table with cards in the air is unaffected: the loop cannot come back around until
`dealHand()` resolves. "All hands finish" and "no new hand starts" become the same single
check.

The FSM transition to `paused` is now guarded on `state === 'running'`. The FSM has no
`waiting -> paused` edge and the gate is now reachable from the idle branches where a
table sits in `waiting`; unguarded, every idle park would have logged a false
"Invalid transition" to Sentry.

---

## Bug 3 — a restart during a break dealt out the rest of it

Of the three `new TournamentManager(...)` sites in `GameServer`, two chain
`holdIfBreakIsRunning` and the **resume-after-restart path did not**. `resume()` has its
own break-recovery block, but it can only recover a break the row knows about. A
tournament that was inside the break window but not yet flagged — it started during the
last-hand wait, or its `pauseForBreak` write lost the race with the redeploy — came back
believing nothing was happening and dealt out the remainder alone.

`holdIfBreakIsRunning` is now chained there too. It is idempotent: `pauseForBreak` no-ops
on a tournament already on break, so the already-recovered case costs nothing.

---

## Bug 4 — the break screen counted down to a time that did not exist

`pauseForBreak` persisted `break_ends_at: null` (correct, and deliberate: at :55 there is
no honest end time yet) while **broadcasting** `breakEndsAt: now + 5 minutes` in the same
breath. Every consumer counted down to that fabricated instant.

Compounding it, `TablePage` matched only `tournament_break` and never
`tournament_break_started`, so the overlay was seeded with a flat five minutes at :55 and
**never re-seeded** when the real countdown began. It reached 0:00 up to two minutes
before play resumed, and `TournamentBreakScreen`'s tick self-terminated at `<= 0` and
never restarted — leaving a player staring at `0:00` under a full-screen opaque overlay
on a live table.

Fixed across the chain:

- **Server:** `tournament_break` now sends `phase: 'last_hand'` and `breakEndsAt: null`.
  `tournament_break_started` sends `phase: 'counting_down'`, the real `breakEndsAt`, and
  `breakDurationMinutes` (absent before, which is why `TournamentClock` fell back to a
  hardcoded 300).
- **TablePage:** handles both events, carries `phase`, `breakEndsAtMs` and `level`.
- **TournamentBreakScreen:** ticks against the wall clock from the absolute end time
  instead of decrementing local state, so a throttled tab, a slow render or a missed tick
  cannot drift and it cannot freeze at zero. During `last_hand` it renders
  "Last Hand / Break Starts When Every Table Finishes" rather than a clock it does not have.
- **NaN:** the progress ring and bar divided by `nextLevel.duration`, a field the server
  has **never** sent on a break payload, rendering `strokeDasharray="NaN 283"` and
  `width: NaN%` on every break, with the timer stuck "urgent red" the whole time because
  every comparison against NaN is false. Progress is now a fraction of the break itself;
  `duration` is optional on the type and unread here.
- **`currentLevel={0}`** was hardcoded in `TableModalsLayer`, so the panel read
  "Coming Next: Level 1" for the life of every tournament. It now uses the level the
  server sent.
- **TournamentClock:** counts to `breakEndsAtMs` when known, uses the seeded duration
  otherwise, and only stamps `breakStartTime` on the first break event — re-stamping on
  the second is what made the clock visibly **jump backwards to 5:00** mid-break.
- **TournamentService:** the three tournament select lists omitted `on_break`,
  `break_started_at` and `break_ends_at` entirely, so `BlindsTab`'s "On Break" panel was
  dead on first paint. Added.

---

## Bug 5 — schema drift

`tournaments.on_break`, `break_started_at` and `break_ends_at` are the entire persisted
state of the break, and **no migration in this repo ever created them.** They were added
out of band; an exhaustive grep found exactly one file referencing them, and that one
`UPDATE`s them and assumes they exist.

`supabase/migrations/20260827120000_break_columns_are_declared_somewhere.sql` declares all
four break columns `IF NOT EXISTS` with the shapes production already has (verified against
`information_schema` first), documents each one, and asserts the types afterwards. Applied
to production as `break_columns_are_declared_somewhere`. Tier 1: additive, no data change,
no row touched.

---

## Verification

- `npx vitest run tests/` — **441 files, 7,118 tests, all passing.**
- `server` suite: `BreakClockIntegrity`, `LevelClockAcrossBreaks`, `TournamentFixes.guard`,
  `TableBreakEngine` — 74 tests passing.
- `npx tsc --noEmit` clean for both the client and `server/tsconfig.json`.
- 8 new tests in `tests/unit/tournamentRakeAndBreaks.test.ts` pinning both regressions:
  that the break gate reads no format, and that the park gate is ordered before the
  short-handed branch and before the deal.
- One pre-existing test pinned the `pauseMaxWaitMs ?? 120000` literal to
  `ServerTableEngineDealing.ts`. The rule is unchanged but the code moved to the base
  class, so that test was updated in the same commit (house rule 8) and now also asserts
  the dealing loop no longer carries a park of its own.

### CONFIRMED ON PRODUCTION — the 18:55 break, 2026-08-27

Engine build `a64e2a22` (contains both PR #1461 and PR #1470), verified serving on
`https://engine.smarter.poker` at 18:30:47 by the deploy's own version gate.

`tournaments` rows, live:

| field                           | Prime Time Main Event (NLH) | Evening Mystery Bounty (PLO5) |
| ------------------------------- | --------------------------- | ----------------------------- |
| `break_started_at`              | **18:55:00.002**            | **18:55:00.175**              |
| `break_ends_at` (stamped later) | 19:00:58.378                | 19:00:58.495                  |
| last-hand wait                  | 58.4s                       | 58.3s                         |

So: announced on the :55 to the millisecond, `break_ends_at` left NULL for the
58 seconds the last hands took, then a full five minutes on top — a 5m58s break
end to end, which is the "up to like a 6 minute break" Dan described.

Hands per minute across the window:

| minute (UTC) | 18:50 | 18:51 | 18:52 | 18:53 | 18:54 | **18:55** | **18:56** | **18:57** | **18:58** | **18:59** | **19:00** | 19:01 | 19:02 |
| ------------ | ----- | ----- | ----- | ----- | ----- | --------- | --------- | --------- | --------- | --------- | --------- | ----- | ----- |
| hands        | 14    | 11    | 12    | 12    | 15    | **11**    | **0**     | **0**     | **0**     | **0**     | **0**     | 5     | 5     |

A hard zero for the whole break, where the 48-hour pre-fix profile always left
stragglers (:56=54, :57=21, :58=34, :59=33). Play resumed at 19:01, immediately
after the 19:00:58 end time. Both rows came off the break cleanly — `on_break`
false, `break_ends_at` NULL — so nothing was stranded.

### Still to be observed: Spin and Heads-Up

The Spin and Heads-Up boards were **not running** at the time of this verification
and had not dealt a hand for hours (last SPIN hand 12:08 UTC, last SNG hand 01:50
UTC, while 33 Spin and 16 Heads-Up rows sat in REGISTERING). That is a separate
fault, unrelated to this work and predating it — but it means the Spin/HU half of
this fix is proven by code and tests, not yet by a live break. The first hour a
Spin or Heads-Up is actually running, re-run the minute-of-hour query below and
confirm those rows take the MTT shape.

### What to check on production after deploy

Re-run the minute-of-hour query. SPIN and SNG should develop the MTT shape — a spike at
:55, then near-silence through :59 — and the MTT `deep_in_break` count should go to zero.
The engine log should stop reporting _"last hand did not land on every table within 120s"_
for tables that had no hand in the air.

---

## Files

```
server/src/GameServer.ts                          break gate, resume-path hold, breakEngines rename
server/src/tournament/TournamentManagerBase.ts    takesSynchronizedBreaks, case-safe isMttOrXmtt, honest payloads
server/src/engine/ServerTableEngineBase.ts        awaitPauseGate (new)
server/src/engine/ServerTableEngineDealing.ts     gate at top of loop + after the deal
src/pages/TablePage.tsx                           handles tournament_break_started
src/components/table/TournamentBreakScreen.tsx    wall-clock tick, last-hand phase, NaN fix
src/components/table/TableModalsLayer.tsx         phase/endsAt/level plumbing
src/components/tournament/TournamentClock.tsx     no hardcoded 300, no backwards jump
src/hooks/useTableTournament.ts                   break state type
src/services/TournamentService.ts                 select the break columns
tests/unit/tournamentRakeAndBreaks.test.ts        8 new tests, 1 updated
supabase/migrations/20260827120000_break_columns_are_declared_somewhere.sql
```
