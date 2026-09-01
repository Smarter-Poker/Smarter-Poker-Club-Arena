# The engine restart happens inside an announced break now

**Dan, 2026-09-01, binding.**

> "A SCHEDULED PAUSE (LIKE A TOURNAMENT BREAK) WHERE 2 MIN BEFORE THE RESTART
> ALL TABLES FINISH THE HAND THEY ARE ON, AS WE ARE DOING AN ENGINE RESTART,
> ALL GAMES ARE THEN PAUSED (NOTHING IS LOST OR CORRUPTED) HANDS FINISH,
> ENGINE RESTARTS AS SCHEDULED AND THE HANDS PICK RIGHT BACK UP AS SOON AS THE
> RESTART IS OVER. (A 5 MINUTE BREAK IS ANNOUNCED) AND ALL HANDS RESUME THEN."

And, in the same session:

> "program the engine restart to be every hour on the :55 instead of every 5
> hours so nothing gets lost or orphaned from production improvements."

## What was wrong

A restart cost about three minutes end to end: up to 45s of `docker stop`
grace, up to 90s of container health-start, and roughly two minutes during
which every table answered 4404 while engines rehydrated from snapshots. The
platform simply ate that, five times a day, with no warning to anybody. Cards
vanished mid-hand, the felt went dead, and a player who reloaded was told
"This Table Is No Longer Running" about a table that was fine.

The gate that was supposed to prevent this could not work. It polled
`/health` for a moment when `handsInFlightTotal` was zero — on a fleet dealing
~290 hands a minute across ~120 tables, that moment never arrives. All 16
polls failed every time, and the only path that ever actually deployed was a
45-minute staleness cap that restarted straight through live play anyway.

Rationing restarts to five windows a day was the other half of the problem:
merged engine code sat unshipped for up to six hours, which is how fixes get
orphaned and how two agents end up reasoning about different production builds
while both believe they are looking at `main`.

## What happens now

| Time | What                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| :53  | Every table is told to finish its hand and start no new one. Players see "Last Hand".                          |
| :55  | Every table is parked between hands. The 5:00 countdown starts. `/health` opens `maintenance.readyForRestart`. |
| ~:55 | SIGTERM. `drainHands()` finds everything already parked and returns immediately.                               |
| ~:58 | The new engine boots, reads the persisted break, and re-parks every table it rebuilds.                         |
| :00  | Every table resumes, together.                                                                                 |

The restart and its rehydration outage now fit entirely inside a window players
were warned about, on tables with no cards in the air. Nothing about the
restart got faster; it became invisible.

**Hourly.** The break runs every hour, and every hour is a restart window. An
hourly window is not an hourly restart: the deploy dedupes on the served
commit, so a window with nothing to ship costs one HTTP request. The engine
bounces only when there is new code, and then within the hour.

**:55 and not another minute** because tournaments already break at :55 and
their blind clocks are already suspended there. An MTT must not be stopped
twice in an hour. This also fixes an old wart for free: because every table is
parked by :55, the tournament break's `waitForAllTablesParked` now succeeds
instantly instead of burning its two-minute grace, so tournament breaks
genuinely run :55 to :00 rather than :57 to :02.

## The three pieces

**`server/src/maintenance/MaintenanceBreak.ts`** — the scheduler. Wall-clock
anchored and re-armed after every firing, never `setInterval`. Parks every
engine with `pauseAfterHand(budget, { beforeNextHand: true })`, which is the
whole guarantee: `beforeNextHand` moves the park to the top of the deal loop,
above the short-handed sleep and the spin-reveal hold, so a table that was
_idle_ at :53 parks too rather than dealing the moment a seat fills at :56.

**`engine_maintenance_break`** (one row) — the break must outlive the process
that declared it, because that process is the one being killed. The booting
engine reads it and re-parks; a browser that loaded during the outage reads it
through `fn_maintenance_break_state()` and shows a break screen instead of a
dead table. The function self-expires, so a crashed engine cannot strand
anyone on a break that ended.

Not `tables.status = 'paused'`, though that enum value exists:
`cash_tables_needing_engine` matches only `('waiting','running')`, so writing
'paused' does not pause a table, it makes the engine _abandon_ it. Same trap
`TableConfigPage` documents for 'active'.

**The client** — `useMaintenanceBreak` + `MaintenanceBreakScreen`. The payload
carries an **absolute end instant**, not a duration, so the countdown keeps
correct time through the two minutes when there is no engine to ask. The 4404
handler no longer says "This Table Is No Longer Running" during a break; it
asks the database first.

## Tests that changed, and why

Per CLAUDE.md rule 8, behaviour these pinned was deliberately replaced, so they
were updated in the same commit rather than left red:

- `deployAndPublishAreHonest` — pinned the five-window cron and the Chicago
  window gate. Both are gone; every hour is a window and there is no timezone
  left to get wrong.
- `deployCannotPinStaleCode` — pinned `MAX_ENGINE_AGE_SEC`. The staleness cap
  is deleted: it existed only because the real path never opened.
- `drainProtectsEveryHand` — pinned `handsInFlightTotal`. The invariant
  underneath it (the deploy must never decide on _who_ is seated) is retained
  and strengthened: there is now an assertion that no horse branch exists in
  the module that decides which tables stop.
- `theCopyRulesReachTheEngineAndTheDatabase` — the "shipped nothing" warning
  is `BREAK NEVER OPENED` rather than `OUTSIDE THE RESTART WINDOW`.

## One bug the tests caught during the build

`readyForRestart` originally accepted `isPausedByDesign()` as evidence a table
had parked. That flag goes true the instant `pauseAfterHand` is _called_ — so
it was true for a table with four players all-in and cards still in the air.
The gate would have opened at :55 whether or not a single hand had finished,
and the restart would have gone in on top of live play: the exact failure this
whole change exists to remove. It now requires `isWaitingForHandForHand()`,
which is only true once the deal loop has actually reached the gate between
hands — the same test `TournamentManagerBase.areAllTablesParked` uses.

## Horses

No `is_horse` anywhere in any of this, and a test asserts it stays that way.
Every table is announced to, parked and resumed identically. Dan, 2026-08-27:
"TIMING IS PART OF THE TREATMENT" — a table that stopped for the break while
the one beside it played on would tell every watching player which seats are
horses.

## Fail-open, fail-closed

- A break row that **cannot be read** on boot: fail **open**, deal normally. A
  database blip must not become a platform outage; worst case is a visible
  restart, which is where we were before.
- A break that **never opens**: fail **closed**, defer the deploy and warn
  loudly. A missed window costs an hour of slightly older code; restarting
  outside the break costs somebody's hand.
- One legacy branch exists and removes itself: the engine in production when
  this lands predates the feature and can never open the flag, so exactly one
  restart is permitted on the old SIGTERM drain.
