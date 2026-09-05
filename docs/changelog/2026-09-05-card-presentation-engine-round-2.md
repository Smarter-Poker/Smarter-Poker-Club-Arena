# 2026-09-05 — Card Presentation Engine, round 2

Follow-on to `2026-09-04-river-squeeze-card-presentation-engine.md` (PR #3072,
merged and live as `6688dea8e`). Dan: "GO AHEAD AND FULLY BUILD ALL OF THESE
AND MAKE SURE THEY ARE FULLY WIRED IN AND TESTED BEFORE CLAIMING SUCCESS. IF
THERE ARE ANY THAT YOU CONSIDER 'HIGH RISK' FOR DAMAGING CODE OR OTHER PAGES,
DO NOT BUILD THEM."

Round 1 shipped the engine and the river. This is everything that was still
open, minus the two items judged too risky (below).

## 1. The snap lands when the card does

The cue used to fire on the STAGE TRANSITION — the moment the server says the
street exists. On a normal street that is close enough to the card appearing
that nobody could tell. On an all-in runout it is **a full second early**: the
card is lying face down while the sound says it landed.

The engine now schedules a `reveal` beat at the edge-on instant (the end of
the squeeze, where the two backface-hidden surfaces swap), and the board pays
the cue there. The cue is OWED at the street and PAID at the reveal:
`snapOwedRef` holds it, and `cancelled` and `complete` pay it too, so an
interrupted or collapsed squeeze still sounds — a card that appears in silence
is the cue being dropped, which 10.6 forbids.

## 2. The turn squeezes, on every hand

`ccTurnReveal` flew a one-sided face in from a 40/45px offset, spun it
mirrored and flashed it to `brightness(1.3)` — the same generic
travel-and-scale the river lost when the video was measured. Two streets of
one hand in two different visual languages is exactly what spec 123 forbids,
and the turn also had no profile: it ignored table focus, platform, and the
all-in pacing the river respected.

The turn now runs the same squeeze, through the same engine, sized by the same
profile table. `.community-cards__card--turn` survives as a marker with no
animation. The flop keeps its own three-card fan on purpose — it is a
staggered fan, not a single-card reveal, and merging them would put a stagger
nothing else uses into the shared piece.

## 3. One piece of markup, shared — and the replay uses it

`src/presentation/cardPresentation/SqueezeCard.tsx` + `cardSqueeze.css` now own
the reveal: two surfaces, the edge spine, the shadow layer, and the five
`--rs-*` variables. `squeezeHostProps()` is the one bridge from the profile
table to the stylesheet.

The felt board renders it. **So does the hand replay**, through the new
`useCardSqueeze` hook on the `replay` profile (960ms, the most cinematic) —
that surface previously swapped `<CardImage>` elements in with no animation at
all, on the one screen where a player is deliberately studying the board.
Stepping backward is not a reveal and does not animate; a step already
presented does not replay.

The board does NOT use the hook: its own effect carries the newly-dealt
window, the rabbit-hunt slots, the multi-board lanes and the sound cue, and
rewriting that around a hook would be a large change to the most-watched
component in the app for no behaviour a player can see.

## 4. The edge spine (spec 73)

At exactly 90deg both backface-hidden surfaces vanish and the card is a
zero-width line. The recording shows a dark card EDGE there. A 2px bar on the
non-rotating host fades in at the swap and out again as the face widens.
Opacity only.

## 5. The shadow follows the flip (spec 72)

The card's shadow used to sit flat on the outer element while the inner card
turned. A dedicated layer now dips its OPACITY through the flip — the blur
radius never changes, so nothing repaints.

## 6. Frame-rate telemetry (spec 63, 64)

Duration telemetry catches an animation cut short. It says nothing about
whether the frames in between arrived: a squeeze that takes exactly 560ms and
paints six frames is a stutter, and duration telemetry calls it a success.
`frameSampler.ts` counts painted frames across one presentation and reports
`animation_performance_degraded` below 45fps with the measured rate. Sampled
at 5% — a rAF loop on every river would be the jank it is measuring. It is
never acted on: degrading an animation because a previous one stuttered is how
a product ends up permanently animation-free after one bad second.

## 7. Visual regression at 25/50/75/100% (spec 106, 107, 109)

`tests/e2e/card-squeeze-visual-regression.spec.ts` drives the real production
keyframes to four fixed points and reads back what the browser computed:

| point | what must be true                                 |
| ----- | ------------------------------------------------- |
| 25%   | still the BACK, narrowing (0 < rotateY < 90)      |
| 50%   | past the swap, on the FACE (90 < rotateY < 180)   |
| 75%   | the face is at full width (rotateY = 180)         |
| 100%  | no residual transform at all (identity, spec 109) |

Plus: the spine exists at the swap and nowhere else, the shadow thins by
opacity with an unchanged blur, and the vertical scale never leaves the
overshoot bound (spec 108 — no distortion). Screenshots are attached to the
report at each point; the assertions are numeric, because a cross-machine
screenshot comparison is a flake generator that ends up disabled. Added to the
`CSS Beat E2E` required check.

## 8. The 1,000-hand soak (spec 98, 99, 100)

`tests/unit/cardPresentation/soak.test.ts` drives 1,000 hands x 3 boards x 2
streets through the real engine, plus a thousand hands abandoned mid-flip and
a thousand duplicate/stale/hidden answers, and asserts every internal
collection returns to its starting size — **including live timer count**,
because the engine schedules two timers per presentation and a cancel path
that forgot one would leak a timer per hand while every other assertion
passed. The engine grew read-only counters (`laneCount`, `processedSize`,
`listenerCount`, `trackedTableCount`) for it.

## Also

- The engine singleton moved to its own module. `index -> useCardSqueeze ->
index` was a real import cycle; ESM tolerates that until an evaluation order
  changes and the singleton is `undefined` at first use.
- `.card-squeeze-host` doubles its own class. The host is somebody else's
  element and `.community-cards__card` sets `overflow: hidden`, which flattens
  a preserve-3d flip; a single class ties on specificity and the winner would
  have come down to bundle order.
- The host is `position: relative` — the replay's `.card.small` is not a
  containing block, and without it the faces escaped the card entirely.

## Not built, deliberately

- **Lightning profile wiring.** The profile exists; Club Arena has no
  lightning/fast-fold table type to resolve it against. Wiring a mode that
  does not exist means inventing its trigger, and that is a guess in a file
  every table renders.
- **Showdown / run-it-twice reveals through the engine.** Both would mean
  changing `SeatSlot` and the RIT reveal scheduling in TablePage — the
  showdown cadence is pinned by `handCompletionLaw` and the RIT timings are
  interleaved with pot shipping. High risk to the felt for a visual change
  nobody asked for yet. The engine is street-generic and ready for them.
- **Focus-arrival replay.** A multi-table tab brought forward mid-hand shows
  the final face with no reveal. That is spec 38's required behaviour
  ("never replay stale animation sequences to catch up"), so it stays.

## Verification

- `npx tsc --noEmit` clean.
- vitest: 73 in `tests/unit/cardPresentation`, 15 in `RiverSqueeze.test.tsx`,
  and 1,881 across the 49 board/animation/law/protected-feature suites.
- Playwright against THIS commit's own build, served locally: 21 passed —
  `live-animations` (every beat of a hand, incl. the rebuilt turn and river
  beats and reduced motion), `flop-fan-open`, and the new 4-point regression.
