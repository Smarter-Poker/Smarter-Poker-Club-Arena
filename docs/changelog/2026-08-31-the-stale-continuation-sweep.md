# The stale-continuation sweep

2026-08-31. The rake-law incident (#2267/#2295/#2318) was one instance of a
CLASS: a delayed continuation - a timer, a retry loop, a catch handler, a
resumed sleep - reading live per-hand engine state that belongs to whatever
hand the table is on when the continuation wakes, not the hand it was created
for. This sweep audited every timer, sleep resumption, retry loop and catch
continuation in `server/src/engine` and closed the remaining instances.

## What was found and fixed

**1. The settlement barrier had two holes (the `board_not_recorded` corpse).**
The dealing loop waits on `postHandTasksPromise` before dealing the next hand,
because dealHand blanks every per-hand capture field and reallocates
`handCount`. But (a) the promise was assigned mid-settlement, so any await
before that line - the insurance-shortfall critical alerts are awaits - let
the loop find a NULL barrier and deal immediately; and (b) the loop walked
away after 45 seconds with the settlement still running, so hand N's history
row was written from hand N+1's blank fields. That is exactly the shape of the
rake-law audit's `board_not_recorded` warnings: rake right, showdown reached,
board empty. Fixed three ways:

- `handleHandCompleteEvent` assigns the barrier FIRST, synchronously, covering
  the whole settlement including the postHandTasks chain (Promise.all).
- `postHandTasks` takes a synchronous SNAPSHOT of every per-hand field before
  its first await and reads only the snapshot - 79 live reads replaced. Even
  a settlement that outlives its hand now writes its own hand's record.
- The dealing loop waits with liveness instead of walking away: 15s slices,
  `markProgress()` each slice so the watchdog stays fed (the only reason the
  45s cap existed), hard cap five minutes - after which it proceeds as before
  but raises a durable `settlement_barrier_abandoned` critical naming the hand
  whose record is now at risk. A table on a database too sick to settle for
  five minutes has no business dealing anyway.

**2. A pre-action could land in the wrong hand.** The pre-action beat
(`preActionVisibleMs`) checked `this.handController` for null-ness after its
sleep, then acted on it. Hand replaced during the beat + the same seat on turn
in the new hand - the common case, since the same player's next hand opens on
the same seat - and hand N's queued check/fold/call consumed the player's turn
in hand N+1. Now anchored: the beat acts only on the controller it was armed
for, or not at all.

**3. Hole cards could be stamped with the next hand's number.**
`persistHoleCardsWithRetry` re-read `this.handCount` on every retry attempt of
`insert_hole_cards`. A slow first attempt (Supabase fetch hangs run long
enough for a fast fold-out hand to end) had attempts 2-3 inserting hand N's
cards under hand N+1's number. The number is captured once, at the deal.

## What was audited and found already sound

The horse think-timer (`handControllerRef` identity check), the pineapple
discard sweep (`controllerRef` anchor) and the controller's own settle beat
(stage-gated, per-controller), the countdown pulse timers (turn-stamp + seat
re-check), the RIT auto-decline and insurance expiry deadlines (per-hand state
cleared by `endHand()` inside the settlement's synchronous section, and lookups
against the live map no-op once cleared), the 10-minute hand void (unsub +
cross-instance guard), the crash-recovery path (abandons, never resumes), the
snapshot coalescer (reads controller and handCount in one synchronous block),
and the action-settle / showdown-settle sleeps in the event pipeline (hand and
controller anchored). ServerTableEngineRunout's cascade was anchored in #2318.

## Pins

`StaleContinuationSweep.law.test.ts` - source-level tripwires in the
RestartFidelity style: postHandTasks contains no live `this.currentHand*` /
`this.handCount` read after the snapshot (comments exempt); the barrier is
assigned in the wrapper; the 45s walk-away is gone and the abandonment alert
exists; the pre-action beat carries its `controllerAtBeat` anchor; hole-card
retries use the captured number; every `safeContinueRunout` call names its
controller. One existing pin in `seatExitMoneyPaths.test.ts` followed the
snapshot rename (`snap.perPotAwards`), assertion otherwise unchanged.

Server suite: 3314 passed, 295 files. `tsc --noEmit` clean.
