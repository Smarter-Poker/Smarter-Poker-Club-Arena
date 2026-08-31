# Crazy Pineapple - the discard you can see and hear (Phase 3 of 4)

**2026-08-31.** Follows #2033 (the right card, off the felt, off the flop),
#2074 / #2131 (the clock is the server's) and #2146 (the forced discard keeps
the best hand; equity is never priced from three cards).

Dan, from a live seat: _"IT DOESN'T REMOVE THE CARD FROM YOU HAND AFTER YOU
DISCARD IT"_ and _"AUTO FOLDED MY HAND, EVEN THOUGH IT DIDN'T."_ Those two
were fixed in #2033 and #2074. What was left is what this ships: a discard
rendered **nothing**.

## What was wrong

The engine has emitted `PLAYER_ACTION` with `action: 'discard'` since the
variant shipped. The client's handler had no arm for it. So:

- no card left anybody's hand;
- no villain's face-down fan ever got smaller - `holeCardCount` is the
  variant's hand size and the variant does not change mid-hand, so a seat that
  had discarded still showed three backs for the rest of the hand;
- `'discard'` was not in the `LastAction` union, so the seat had a live action
  it could not name, label or animate;
- the one cue that did fire was `soundService.playFold()` - the wrong action's
  sound, and a two-card brush for a one-card decision, in the one variant where
  throwing a card is how you **stay in**;
- the street opened on the same synchronous tick as the last discard.

Worst of it is §10.5. Horses discard on a deliberate 1.2s-5.2s humanlike delay,
which exists so a horse cannot be told from a human. With nothing rendering,
the felt paused and then jumped: the pause was there and the thing it was
hiding was not.

## What changed

**`playDiscard()`** (`SoundService.ts`) - one card swept away on a downward
bandpass, landing on a soft felt tap. Its own `SoundPriority` at rank 45:
above `fold` (30) and `deal` (20), below `call` (50). Several seats discard
inside one 50ms priority window, and `playPotCollect` is the standing proof
that a cue ranked too low is wired, called and permanently inaudible.

**A per-seat toss** (`SeatSlot.tsx` / `.css`, `TablePage.tsx`) - one card, and
only one, flies to the same muck the fold heads for, off `--fold-to-x/y`, over
420ms scaled by `--animation-speed`. It is a ghost: by the time it renders the
hand has already given the card up. Fired off `lastAction` alone, so a horse's
discard is the same animation, the same cue and the same timing as a human's,
and there is no `is_horse` anywhere near it. A villain's fan now drops from
three backs to two.

**The card is still private.** A villain's ghost is a card **back**, drawn from
the public `player_action` event, which carries a seat and the word `discard`
and nothing card-shaped. Hero's own card is passed to their own seat inside
their own client and never crosses the wire - hole cards ride RLS-protected
`table_hole_cards` (migration `20260312_secure_hole_cards_fix.sql`) because of
a prior god-mode vulnerability, and that stays true here.

**A beat** - `HAND_COMPLETION.DISCARD_SETTLE_MS` (600ms) in
`handCompletionSpec.ts`, honoured by `HandController
.checkPineappleDiscardsComplete`, so the flop's betting round no longer opens
over a card that is still in the air. It is written so it cannot park a hand: a
zero or unusable timer advances synchronously, the callback re-reads the stage,
`cancelPineappleSettle()` is called by `completeHand` and by the engine when it
drops a controller, and `flushPineappleSettle()` collapses it for drivers that
have no clock.

Two consequences worth naming:

- `ServerTableEngineRunout.submitDiscard` used to ask "is the round over?" by
  reading `stage !== 'pineapple_discard'`, which was only ever true because the
  advance was synchronous. During the beat that reading would have re-armed the
  fold sweep against a table where every seat had already acted. It now asks
  `handController.allPineappleDiscardsIn()`.
- `HandFuzzer` walks a whole hand inside one synchronous loop and its LIVENESS
  law ("no player to act and hand is not complete") is real. It collapses the
  beat rather than the engine pretending it does not have one.

## Reduced motion

Not marked `data-motion="keep"`, deliberately. The length of this animation
carries no information; that a card left the hand is carried by its final frame
and by a row that is one card shorter, and `reducedMotion.css` collapses to 1ms
rather than `animation: none` precisely so a `forwards` animation still lands.
Motion collapses, the meaning does not. There is no toggle - `--animation-speed`
is the only control, per §10.6.

## Pinned

Eight new pins in `tests/animations-always-play.law.test.ts` (45 → 53), each
naming the bug it prevents. One existing pin in
`server/src/engine/PineappleDiscardFold.test.ts` was **moved, not weakened**: it
asserted the advance on the same tick, which is the mechanism that changed. It
now asserts that the round is still held during the beat and advances when the
beat elapses - plus a new pin that a hand ending inside the window does not
advance afterwards.
