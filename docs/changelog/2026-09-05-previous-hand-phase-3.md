# Previous Hand, Phase 3 of 7 - the replayer moves

Plan: `docs/PREVIOUS-HAND-REPLAYER-BUILD-PLAN.md`. Branch
`feat/previous-hand-phase-3`, off `main` at `736831960` (Phase 2 review).

## What changed

The replayer stepped between still frames: the pot figure changed, a bet pill
appeared, a card was there or was not. Every frame was correct and nothing
between two frames was shown. Now stepping FORWARD one frame plays what
happened between them, with the felt's own sounds, and a jump or a scrub shows
the frame without replaying the road to it.

### Motion (`src/utils/replayMotion.ts`, `HandReplay.tsx`, `HandReplay.css`)

`frameMotion(prev, frame, winnerSeats)` decides, purely, what moves:

- **Chips in.** On a posting, a bet, a call, a raise or an all-in the seat's
  bet pill slides from the seat to its bet spot (`hr-bet--in`, keyframe start
  from the seat's own `--hr-from-x/y`). A returned uncalled bet and a check
  move nothing.
- **Sweep.** A new street (and the final frame) sends every committed stack to
  the pot and fades it (`hr-bet--sweep`), the folded blind included. A stack
  dropping to zero MID-street is a returned bet, not a sweep.
- **Flip.** A seat whose cards turn face-up flips them (`hr-seat__cards--flip`,
  staggered per card). The viewer's own seat never flips: their cards were
  face-up from the deal.
- **Fold.** The folding seat's backs go to the muck and stay gone
  (`hr-seat__cards--fold`, `forwards`).
- **Award.** On the final frame the pot pill travels to each winner
  (`hr-pot-fly`), the pot ring pulses (`hr-felt__pot--award`) and the winner's
  stack grows and turns house green (`hr-seat__stack--grow`).
- The acting seat's plate breathes once (`hrActPulse`).

Motion is owed to a STEP. `prev` is null on a jump, a scrub, and the first
frame, and null moves nothing. The component keeps `{ step, motion }` together
so every way of arriving at a frame says which kind it was: Next, ArrowRight
and the playback tick step; First/Last/Home/End, the scrubber and the street
jumps jump.

### Every duration is the player's

`--hr-move: calc(var(--animation-speed, 1) / var(--hr-rate, 1))` on
`.hand-replay`. `--animation-speed` is the table's setting (0.25 to 3);
`--hr-rate` is the replay's own rate (0.5, 1, 2). Every Phase 3 animation is
`calc(<ms> * var(--hr-move))`; the playback beat is `replayBeatMs()` with the
same two factors. Neither can reach zero, so neither can switch motion off:
the fastest pair is still motion (animation law, CLAUDE.md 10.6). Under
`prefers-reduced-motion` the global collapse lands each movement on its final
frame in 1ms, and every final frame here carries the meaning (chips at the
spot, sweep gone, cards face-up, fold gone), so nothing needs
`data-motion="keep"`.

Verified in the built-in browser (WebKit) that a keyframe `from { left:
var(--hr-from-x) }` resolves against the element and interpolates to the
laid-out position (360px -> 240px over the duration), and that
`calc(4000ms * var(--zm))` with a rate of 2 yields a 2000ms effect.

### Sound

`frameCue(prev, frame)` names one cue per frame stepped into, mapped onto the
felt's own SoundService verbs: postings and calls `playChips`, bets and raises
`playRaise(amount, bigBlind)` (the felt's size-scaled clink), `playCheck`,
`playFold`, `playAllIn`, `playDiscard`, a show `playShowdown`, a new street
`playCommunityCard`, the deal `playDeal`, the result `playWin` + `playPotCollect`.
The gate, the priority window and the player's sound setting are all
SoundService's; the replay has no second sound set and no mute of its own. No
cue on opening (nothing was stepped into), none on a jump or a scrub.

### On the felt

- **Dealer button** (`hr-button`): the record's `buttonSeat`, or the seat the
  positions name `BTN`, drawn between the seat and its bet spot.
- **What the acting seat was facing** (`hr-facing`): `facingAt(prev, frame)`
  reads the frame BEFORE the decision - the pot and commitments the player saw
  - and shows chips to call, pot odds as a percentage and as `x : 1`. Nothing
    on a posting, a show, a returned bet, an open, a check with no bet in front,
    or the first frame of a street. Pinned: the button opening into a 1/2 blind
    is 2 to call into 3 (40%, 1.5 : 1); calling 94 into 106 is 47%.
- **Made-hand label** (`hr-seat__made`) under every seat whose cards the
  viewer can see: the model's own per-street `madeHands` (the same evaluator
  that names the showdown), the showdown's name on the final frame, and before
  the flop the holding itself for two-card games ("Pocket Nines", "Ace King
  Suited"). Omaha and Pineapple holdings get no preflop word.
- **The viewer's own cards from the deal.** Until now a player replaying a
  hand they took to showdown watched two card backs in their own seat until
  the showdown frame (`privateHole` is only set on hands NOT shown). The felt
  now shows `hole ?? privateHole` face-up in the viewer's seat from frame 0,
  marked "Yours" until the record shows them.

### Controls

- **Speed** (`hand-replay__rate`): ½×, 1×, 2×, remembered per viewer in
  `localStorage` (`ca_replay_rate`, read and written in try/catch; nonsense
  reads as 1×). Independent of the table's Animation Speed, which still scales
  underneath.
- **Street jumps** (`hand-replay__jumps`): Deal, then the first frame of each
  street the hand reached, with the current one lit. Home / End jump to the
  first and last frame.

## Pins

`tests/unit/previousHandPhase3.test.tsx` (19): motion per frame kind on a real
built model (chips in, sweep incl. the folded blind, no sweep on a returned bet
or an unbet turn, fold, flip, award); cue per verb and none on a jump; facing
read off the previous frame with exact figures and every "nothing" case; beat
scaling by both factors with a floor; the rate's round trip, nonsense and a
throwing storage; street jumps in order; preflop labels; and the rendered
replayer: dealer button, six jumps, three rates, the viewer's own cards and
label at frame 0, no cue on open, step = motion + sound, jump/scrub = neither,
the sweep count on stepping into the flop, the award on stepping into the
result, the rate written to storage and to `--hr-rate`, and playback ticking at
the beat under fake timers.

`tests/animations-always-play.law.test.ts` gains "LAW: the hand replayer
moves, at the player speed, never switched off": every Phase 3 animation
duration derives from `--hr-move`, no literal millisecond, no
`animation: none`, the rates are `[0.5, 1, 2]`, the cues are SoundService's.

## Not in this phase

- The deal itself is not animated card-by-card to the seats (the frame shows
  the seats dealt in); the board still reveals through the Phase 2 squeeze.
- Motion plays for a step forward only. Stepping BACK shows the earlier frame
  without reversing the animation.

## Seen on real hardware

Rendered through a throwaway Vite harness (deleted, never committed) in the
built-in browser pane at desktop width and at 375px, dark and light: chips
slide from the seat, the flop sweep carries three pills (the folded blind's
included) into the pot, the fold fades, the river squeezes, the shows flip,
the pot pill flies to the winner and the stack turns green. Three layout
defects were found there and fixed in the same branch:

- the facing badge and the action label hung OUTWARD on the edge seats and
  were clipped by the felt (`hr-seat--left/right/top/bottom` now hang them
  inward; the bottom seat's badge sits above its cards and its action label
  on the plate's right shoulder);
- the bottom seat's plate ran past the felt at a 40% vertical radius (now
  36%), and its made-hand label sits beside the plate rather than under it;
- the dealer button overlapped the bottom seat's first card (now on a wider
  ring, 0.3 rad clockwise).
