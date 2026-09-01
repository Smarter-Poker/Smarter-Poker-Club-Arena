# The stage travels with the action (2026-09-01)

## What was wrong

On 2026-08-31, 517 real play actions were persisted with `stage: 'showdown'`:
151 check, 127 call, 78 fold, 73 bet, 55 all_in, 33 raise. They were not
scattered -- they sat in 30 hands at roughly 17 actions per hand, and every one
of those hands had an empty board.

`hand_history` for `5e969448-bf2d-4e16-a551-660119e7f37a` holds 23 actions: the
two blinds correct at `preflop`, and all 21 subsequent actions at `showdown`.

## Root cause

Two records of the same action are written by two different writers.

`HandController.performAction` pushes to its own `actionHistory` with
`stage: this.state.stage`, synchronously, at the instant of the action. That
copy is always correct.

The PERSISTED copy is built by the `PLAYER_ACTION` case in
`ServerTableEngineHandEvents`, which did this:

```ts
const hcState = this.handController?.getState();
const stage = hcState?.stage || 'preflop';
```

That reads the stage off the LIVE controller at the moment the handler runs.
`performAction` emits and then calls `advanceGame()`, so any drain that lags
the advance sees a stage that has already moved on -- and a whole hand's events
draining after the hand completes all read the stage the hand ENDED on. The
blinds escaped because they are stamped `'preflop'` literally, further up the
same file.

Board capture was checked and is sound: all 62 three-card, 307 four-card and
9,190 of 9,895 five-card boards carry matching postflop actions. Only the
stage label was wrong.

## Why it is not cosmetic

`HorseHandReview` keys `heroPre`, `postflopActed` and every river detector off
this field. On those 30 hands `postflopActed` was true for a hand that never
saw a flop, and a preflop shove read as river aggression -- so the leak
detectors were being fed hands whose streets were fiction.

## The fix

The stage is now frozen ONTO the event by `HandController` at the instant of
the action, from the same value it writes to `actionHistory`. The consumer
reads `event.stage ?? hcState?.stage ?? 'preflop'` -- the live-state read stays
as a fallback so no emitter is silently wrong. The two records now agree by
construction rather than by how promptly a listener happens to run.

`stage` is optional on the event type for that reason, and all four
`PLAYER_ACTION` emit sites in `HandController` now set it.

## Proof

`ActionStageTravelsWithTheEvent.test.ts` reads the events only AFTER the hand
has finished -- the exact late drain that caused the corruption -- and asserts
each action still carries its own street. Reverting either half of the fix
turns all four pins red; that was run, not assumed. Full engine suite after
the change: 144 files, 1573 tests, 0 failures.
