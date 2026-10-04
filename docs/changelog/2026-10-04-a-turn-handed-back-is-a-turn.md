# A turn handed back is a turn (2026-10-04)

Dan, after a human-versus-human match: "THE HUMAN VS HUMAN THAT WAS JUST
PLAYED, RESULTED IN MY HUMAN OPPONENT CONSTANTLY BEING TIMED OUT OR
DISCONNECTED... THIS NEEDS TO BE BUG HUNTED, AND FULLY FIXED AT ONCE!"

Client change. It uses engine behaviour that is already live (the decision
context on every snapshot and turn_change, the `/preaction` replies). No
engine dependency and no database change.

## The match, read from rows

Table `58b2c844` ("NLH 2/5 Madness"), heads-up, 2026-10-04 19:40 to 19:53 UTC.
Seat 2 was the opponent on an iPhone, seat 6 was Dan. Beside it Dan's account
was seated at a heads-up sit-and-go, table `a84e44e8`, against a horse.

Every time seat 2 closed a street and was first to act on the next one, the
decision took at least 15.9 seconds. There were eight such turns:

| Hand     | Street | Seconds | How it ended             |
| -------- | ------ | ------- | ------------------------ |
| 23670786 | turn   | 37.7    | engine forced the check  |
| 23670786 | river  | 37.8    | engine forced the check  |
| 23677310 | flop   | 37.7    | engine forced the check  |
| 23679200 | turn   | 36.9    | acted in the last second |
| 23680808 | flop   | 20.1    | acted                    |
| 23680808 | turn   | 17.6    | acted                    |
| 23680808 | river  | 20.5    | acted                    |
| 23684139 | flop   | 15.9    | acted                    |

37.7 seconds is the whole clock: the 0.5s street beat, 15s to act, the 2s
grace and the full 20s time bank. In the same sixteen hands, seat 2 opening a
street that SEAT 6 had closed took 2.2 to 10.0 seconds.

It is not that player and not that phone. Every human decision on the
platform in the week of 2026-09-28, first to act on a new street:

| Who closed the previous street | Turns | Median | Past 14s | Forced by the engine |
| ------------------------------ | ----- | ------ | -------- | -------------------- |
| The same seat                  | 27    | 37.7s  | 85%      | 67%                  |
| Another seat                   | 48    | 3.8s   | 2%       | 0%                   |

## Cause 1: the page withheld the turn the engine handed back

When a player acts, TablePage hides the action bar at once and arms a fence
(`heroActedFenceRef`): for 1500ms it refuses any frame that names the seat
that just acted, because the engine's first snapshots after an action still
do (Dan 2026-08-27, "the action bar reappears for a split second").

That is also an exact description of the engine handing the same seat the
next street. Captured from the real `ServerTableEngine` and `HandController`
with a recording hub; seat 2 calls the flop bet at +2624ms and is first to
act on the turn:

```
+2625  SNAPSHOT  flop  actor seat 2  context flop:5:2:10  clock 2423
+2626  SNAPSHOT  turn  actor seat 2  context turn:5:2:0   clock 2423
+3126  SNAPSHOT  turn  actor seat 2  context turn:5:2:0   clock 3126   <- the turn
+3126  EVENT turn_change seat 2      context turn:5:2:0
```

The armed turn and its `turn_change` both land 500ms after the action, inside
the window, and both were withheld. The engine publishes nothing further for
that turn, so the player sat with no action bar and no clock until the engine
resolved the seat, or until they reloaded the page. A reload sends the
`/away` beacon, which the engine reads as the player leaving: that is the
"disconnected" half of the report. Three timeouts in a row sit the seat out.

Two changes made it, and it needed both. On 2026-09-07 the engine's street
beat was cut to 500ms, which put the armed turn inside the 1500ms window. On
2026-09-09 the same fence was applied to the `turn_change` event, the one
frame that until then landed last and put the bar back.

**The fix.** The fence now judges the DECISION, not the seat and the clock
(`src/lib/heroActedFence.ts`). It records the engine's own `action_context`
for the decision the player answered, and the engine turn clock it ran on.

- A frame carrying the answered decision is stale and is withheld, as before.
- A `turn_change` for the same seat with a different decision is a new turn
  and is applied at once. The engine emits that event only after arming.
- A snapshot is a new turn when it carries a different decision AND a turn
  clock newer than one already seen on a withheld frame. Engine clock is
  compared with engine clock; no device time is involved.
- Whatever is still withheld when the window closes is delivered then, unless
  the engine's last word was the answered decision or no decision at all (a
  showdown).
- A folded seat is offered nothing. The engine goes on naming a seat whose
  fold ended the hand, with a betting context, until it deals the next one.

The snapshot merge, the `TURN_CHANGE` handler and the release timer all ask
the one rule. The inline copies are gone.

## Cause 2: a pre-action that armed itself

Found in the same hour, on Dan's own seat. In the sit-and-go, 13 of the hands
between 19:39:44 and 19:41:58 show seat 1 folding with origin `pre_action`,
most of them within half a second of the deal. He had armed one pre-action.

At a hand boundary the page clears the pre-action. When the hand is already
over the engine answers that clear with HTTP 400 "No active hand". The API
layer dropped the sentence (`Server error (400)`), the page read the refusal
as "the engine is still holding it", put the control back with
`setPreAction(armed)`, and that state change ran the ARM branch: the
pre-action was sent again and landed in the next hand, where the engine
executes an arm that arrives on the player's own turn immediately. The fold
ended the hand, which cleared the pre-action, which was refused, which
re-armed it. The engine's own copy of an armed pre-action, pushed to every
socket the player has open, was also sent back as a new arm by every other
tab and device.

Production, 19:40 and 19:41 UTC: 68 to 98 refused `/preaction` requests a
minute from each of three open tabs of the one account.

**The fix** (`src/lib/preActionSync.ts`, moved out of TablePage's effect so it
can be driven with the engine's real replies):

- `GameServerAPI.setPreAction` keeps the engine's sentence and marks the reply
  as an answer. "No active hand", "Player not found at this table" and a 404
  complete a clear: nothing is armed and nothing can run. Not retried, not
  restored, not announced.
- Only an undelivered request is retried, and an attempt stands down once the
  player has changed their choice or the hand it was for has left the felt.
- Showing what the engine holds is not arming it. The restore after an
  undelivered clear and the engine's own copy go on screen through a one-shot
  marker (`preActionHeldByEngineRef`) and send nothing.
- A 404 from `/preaction` no longer counts toward the circuit breaker every
  open table shares (three of them paused every table's heartbeat for 30s).

## Cause 3: the page folded for the player

Six times in those hands a popup said "The Table View Is Out Of Date. Reload
To Continue.", on the lobby and the financial pages as well as at a table.
Each was TablePage's own fold (`handleTimerAutoFold`): when the local ring
reached zero it asked for a time bank, and on a refusal it submitted a fold.

| UTC          | What                                                   |
| ------------ | ------------------------------------------------------ |
| 19:38:11.025 | engine force-folds seat 1 (its time bank ran out)      |
| 19:38:11.131 | the page's fold is refused, popup                      |
| 19:38:55.631 | engine force-folds seat 1                              |
| 19:38:55.647 | refused, popup                                         |
| 19:42:15.251 | engine force-folds seat 1                              |
| 19:42:15.311 | refused on three clients (to 19:42:17.031), popup each |

A refused bank request usually means the turn is already over, so the fold
that followed was for a hand the engine had finished. It carried no decision
context (the callback closed over a submitter from an earlier render), which
is the only reason the engine refused it. With the right context the same
code folds a player during a time bank: the engine extends a turn for a bank
without publishing a new deadline, so "six seconds past the deadline" is the
middle of the bank, and a hidden tab's timers run late.

**The fix.** The client-side fold is removed. The engine checks or folds an
expired seat itself. On a refused bank the clock stops showing borrowed time,
and that is all. `tests/unit/timeBankSeatFeedbackAndCards.test.ts` pinned the
fold ("still auto-folds on every other refusal"); that pin is replaced in the
same change.

## Tests

- `tests/unit/heroActedFence.test.ts`: the engine's captured frames (same-seat
  street boundary, turn moves on, street closes for another seat, showdown, a
  fold that ends the hand) played through the previous rule, kept as a
  witness, and the new one. The previous rule leaves the seat with no turn.
- `tests/unit/preActionSync.test.ts`: the loop replayed against the previous
  effect (the pre-action lands in the next hand), then the new sync against
  the engine's real replies, four clients, late answers, and the API layer.
- `tests/unit/theEngineOwnsAnExpiredTurn.test.ts`: no action leaves the page
  except from the action panel handler.
- Pins moved with the code, in this change:
  `tests/one-event-one-application.test.ts`,
  `tests/unit/LiveHandNeverDimsAndPreActionsLand.test.ts`,
  `tests/unit/preActionArmedPriceIsTheEngines.test.ts`,
  `tests/lightning/lightning-tablepage-pool-session.test.tsx`,
  `tests/unit/timeBankSeatFeedbackAndCards.test.ts`.

## Found, and not changed here

- A tab that stays on a table keeps the bundle it loaded until it leaves the
  table route, so a seated player keeps the old fence until then. Reloading
  the table picks this up.
- The engine still answers a clear with "No active hand". The page now reads
  that correctly; making the engine answer `success` (so a bundle that
  predates this change cannot loop) is an engine change and a separate
  release.
- The account was open on four clients at once (three tabs and a phone). Each
  ran its own clock for the same seat. Causes 2 and 3 were multiplied by that;
  cause 1 was not.
- The sit-and-go's second seat was taken by a horse a few seconds after Dan
  sat, before the human opponent's tap landed ("That Seat Was Just Taken").
  That is a separate defect with its own fix: #6099, the same day, keeps a
  human's open seat for people.
- The pre-push hook's receipt reads `local-prepush: passed` when the hook is
  killed by a signal before it finishes (seen while delivering this change:
  the related-test phase was still running). The push itself did not happen,
  so nothing unverified left the machine, but the receipt is wrong.
- `EngineLeaseBoundary.guard.test.ts` pins a lifecycle check inside
  `setPreAction` through a slice that runs to the end of the class, so it
  passes without the method containing one.

## Not verified

- Not exercised in a browser or on a device. The rules are tested against
  frames captured from the real engine code; the TablePage wiring is pinned by
  source, not by a mounted test.
- The production measure above needs humans to play hands on the published
  build before it can be read again.

## Policy receipt

`node docs/agent-policy/agent-policy.mjs read`: policy 2.9, manifest
`a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`, emitted
2026-10-04T21:38:49Z at this branch's base.
