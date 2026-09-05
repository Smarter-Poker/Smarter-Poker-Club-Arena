# 2026-09-05 — Card Presentation Engine, phase 2

Dan: "MOVE ONTO PHASE 2 OF THIS COMPLEX BUILD, UPGRADE AND ENHANCEMENT PHASE
OF THE RIVER SQUEEZE ANIMATION."

Round 1 (#3072, live) built the engine and the river. Round 2 added the
reveal-beat cue, the turn, the spine, the shadow, frame telemetry, the visual
regression harness and the soak. Phase 2 closes the Definition of Done items
that were still open, and brings the last two surfaces onto the pipeline.

## 0. First, the branch was dirty

Round 2's PR (#3086) had gone `dirty`: `main` moved 30-odd commits under it and
**replaced `HandReplay.tsx` wholesale** (#3089 — `buildReplayFrames`, a real
felt replayer). Took main's component whole and re-applied the squeeze to it.
The result is better than what it replaced: the hook is called once per board
in a `ReplayBoard` component, so **run-it-twice and bomb-pot boards each get
their own animation key** — spec 81 by name, which the old flat render could
not have had.

## 1. Every street goes through the engine, the flop included (spec 58)

The flop's fan is visually untouched — same two-phase land-and-open, same
numbers, same three staggered snaps on the street (a single reveal beat does
not describe a shape that opens at 0.52s, 0.66s and 0.80s). What it gains is
everything the engine owns and the flop never had:

- an **identity**, so a resync cannot re-fan a flop already on the felt;
- the **hidden-table rule** — a board nobody can see does not animate (spec 47);
- the **out-of-order guard**;
- **telemetry**.

A refused flop clears all three indices, not one — `delete(slot)` would have
left two of the three still fanning.

## 2. A street the board has already passed never animates (spec 16, 84, 103)

Hand-level staleness could not catch a late **turn** arriving after the river
of the _same_ hand: same hand, same board, and the registry only knew the turn
had not been presented _before_ — not that the board had since moved past it.
A reconnect replays exactly that shape, and animating it turns a card over
that is already face up. The engine now tracks the furthest street per lane
per hand. Per **board**, so board 2 is never held back by board 1.

## 3. Interrupts the spec names and nothing implemented (spec 39, 40, 66, 76, 77)

| event                | why it invalidates a flip                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| resize / orientation | the felt row is `flex: 0 1 (100% - gaps)/5`, so every card changes width; a card mid-rotateY finishes against a box that is no longer its box |
| tab backgrounded     | rAF and CSS timelines throttle; on resume the browser may finish instantly or jump, and the hand has usually moved on                         |

All three cancel, and the board renders its authoritative final state —
correctness beats visual continuation. A card that snaps face-up is a
non-event; a card left standing on its edge is a bug report. Installed **once**
beside the singleton, not per board: a multi-tabling client would otherwise
carry one resize handler per table, all doing the same thing. The resize
settle is debounced so a drag cancels once, not sixty times.

## 4. Asset preloading (spec 41, 42)

The moment a reveal starts, every newly dealt face and the card back are
decoded off to the side with `HTMLImageElement.decode()` — which resolves when
the bitmap is ready to _paint_, not when the bytes land. A face is hidden
behind `backface-visibility` for the first half of a turn, so a warm cache
never noticed; a cold one (a deck the player has never been dealt, the first
hand after a deploy rehashed every asset) could deliver the bitmap _after_ the
surfaces swap, and the card turned over to an empty box. Fire and forget,
never awaited, bounded cache.

## 5. Spectator profile (spec 36, 94, 115, 118)

An unseated viewer resolves `spectator-desktop` — same shape as cash and
deliberately not faster (someone watching is doing nothing _but_ watching, so
there is no action cadence to stay out of the way of), with its own id so
watched hands and played hands stay separable in telemetry; their device mixes
differ and averaging them hides both. The presentation layer learns a **mode
name** and nothing else — no payout, blind level or wallet reaches it, and a
test enforces that by scanning the whole module.

## 6. Theme tokens (spec 51, 53)

`--rs-edge` and `--rs-shadow` now indirect through `--table-card-edge` /
`--table-card-shadow`, which a table theme can set the same way
`src/lib/tableTheme.ts` sets `--felt-gradient`. No theme sets them today; the
point is that nothing in the reveal is a colour a theme cannot reach.

## Verification

- `npx tsc --noEmit` clean.
- vitest: **658 files, 9,341 tests**, all passing — including
  `animations-always-play.law`, `law-registry`, `protectedFeatures`,
  `replay-never-fabricates`, and the 1,000-hand soak.
- Playwright in real Chromium against **this commit's own build**, served
  locally: **21 passed** — `live-animations` (every beat of a hand, incl.
  reduced motion), `flop-fan-open` (all five flop beats, unchanged), and the
  4-point squeeze regression.

## Still not built, still deliberately

- **Lightning**: the profile exists; Club Arena has no lightning table type to
  resolve it against. Wiring a mode that does not exist means inventing its
  trigger in a file every table renders.
- **Showdown / winning-hand through the engine**: both mean changing
  `SeatSlot`, whose cadence is pinned by `handCompletionLaw` and whose winner
  state is a deliberate hard cut (10.6 / the PokerBros parity pass). High risk
  to the felt for a change nobody has asked for.
- **Focus-arrival replay**: a tab brought forward mid-hand shows the final
  face with no reveal. That is spec 38's required behaviour, not a gap.
