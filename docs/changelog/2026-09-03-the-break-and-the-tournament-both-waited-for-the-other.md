# Two authorities deferred to each other and the table stayed dark

**2026-09-03**, found auditing the engine after the publish work. Not reported
by anyone: the symptom is a tournament that goes quiet for five to ten minutes
after an hourly break and then comes back, which reads like slowness.

## The deadlock

`maintenancePaused` is cleared in exactly one place -
`ServerTableEngineBase.resumeFromMaintenance()` - which has exactly one caller,
`MaintenanceBreak.resumeEveryEngine()`. That loop **skipped** any table
`shouldStayPaused()` was true for, meaning a tournament that was also on a
break of its own:

    if (this.deps.shouldStayPaused?.(tableId)) { ...; continue; }

The intent was right and is written on the line: a tournament add-on break runs
up to ten minutes, so one starting near `:55` outlives the five-minute
maintenance break, and resuming its tables here would deal that event back into
play while its own clock still has it away.

But the tournament could not resume it either. `resumeDealing()` early-returns
while the maintenance flag is set - deliberately, so hand-for-hand's 500ms sync
loop cannot deal a hand inside a break:

    resumeDealing(): void {
      this.handForHandPaused = false;
      if (this.maintenancePaused) { ...; return; }

So the break waited for the tournament, the tournament waited for the break,
and nobody released the table. It sat dark until `reviveDeadTableEngines`
noticed it had been paused past `MAX_HEALTHY_PAUSE_MS` (10 minutes) and **tore
the engine down to rebuild it** - recovery by demolition rather than by
resuming, five to ten minutes late.

Deterministic whenever a tournament break outlives the maintenance break, and a
live race for every ordinary `:55` break, since both ends fire at `:00` and
whichever runs first decides.

## The skip was never needed

`resumeFromMaintenance()` already honours the other authority - it always has:

    resumeFromMaintenance(): void {
      this.maintenancePaused = false;
      if (this.handForHandPaused) return;   // hand-for-hand still owns the table
      this.releasePauseGate();
    }

It clears **only its own flag** and returns without releasing the gate when
something else holds the table. And every tournament break holds its tables
through `pauseAfterHand()`, which sets exactly that flag - verified at all three
break paths in `TournamentManagerBase`.

So the correct split, which the code already supported: **the break releases
what the break took, and the other authority keeps what it took.** Every table
now gets `resumeFromMaintenance()`. A held table still will not deal; it simply
regains the ability to be resumed by whoever is actually holding it.

## The test was pinning the deadlock

`MaintenanceBreak.test.ts` asserted `resumeCount === 0` for the held table -
pinning the bug. Its `FakeEngine` also cleared `paused` unconditionally, which
is _why_ skipping looked correct: the fake did not model the real contract.

The fake now models it (clears the flag, releases the gate only when no other
authority holds it) and the pin moved, in this commit, to the honest property:
**the break released its own flag (`resumeCount === 1`) and the table still did
not deal (`paused === true`).** Mutation-verified - restoring the `continue`
turns it red with `expected +0 to be 1`.

## Also: the fault-injection drill voided a horse's hand

`faultInjection.ts` refused to run a drill when any human was seated, then
`kill_engine` tore the table down mid-hand for a table full of horses.

CLAUDE.md 10.5 settled this shape once already, in the deploy drain gate:
**PROTECT THE HAND, NOT THE PLAYER.** A horse pays the same buy-in out of the
same club wallet, and a voided hand costs it the same chips. The drill now waits
for `isBetweenHands()` - the same boundary the maintenance break waits for - so
it takes the table at the moment every other restart path takes it, rather than
whenever the request happens to arrive.
