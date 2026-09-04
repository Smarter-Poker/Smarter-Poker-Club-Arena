# PLO opens pot, and the PLO stack-off detectors (2026-09-03)

Dan, binding: "horses min-raising in PLO is unacceptable ... a min-raise is
NOT the standard PLO opening raise." He also flagged hand #5428599 as the
stack-off that followed from it.

## What was measured

Production, 2026-09-02, 40,232 PLO preflop opens:

| metric                     |   PLO |   NLH |
| -------------------------- | ----: | ----: |
| average open               | 2.62x | 2.87x |
| min-raise (<= 2x BB)       | 37.4% | 26.8% |
| pot or bigger (>= 3.4x BB) | 11.7% | 13.5% |

786 of the 825 horses with five or more PLO opens min-raised; 495 did it on
a quarter or more of their opens; 39 never did. The diagnostic tell is that
the POT-LIMIT games opened SMALLER than the no-limit game, which is
backwards, and the near-total spread across the fleet says one shared code
path rather than a persona dial or tuner drift.

## What it actually was

`HorsePreflop.decidePreflopV7`, the V28 open-size ladder: `2.2 + rand()*0.8`
big blinds, narrowed to `2.05 + rand()*0.35` with an ante and `2.0 +
rand()*0.4` at 25bb or under (its own comment: "min-raise territory"), then
multiplied by the persona's `sizingMultiplier`, whose base runs 0.88-1.12
before style modifiers apply on top. Nothing in that ladder had ever asked
what betting structure the game was played under, so the no-limit ladder ran
the pot-limit games and the low end of it landed at or under the 2x min
raise, where `legalize` clamped it.

`HorseLogic.decidePreflop` — the `v7Preflop: false` fallback and ablation
route — carried the same ladder, and the 3-bet and 4-bet sizings on both
paths were no-limit multiples of the current bet. Out of position those
overshot the pot and were clamped back down to it; IN POSITION they asked
for 2.5-3.0x and landed UNDER the pot, which is where the cheap PLO pots
were being built.

## The fix

`potLimitRaiseTo(pot, currentBet, toCall)` in `BettingStructure.ts` — the
engine's own pot-limit formula (Bible V8 4.14, the same arithmetic
`calculateBettingState` uses for `maxRaise`), lifted so the horses can SIZE
to the ceiling rather than only be clamped by it. Read off the live pot, it
stays correct with antes, straddles, dead blinds and limpers, where a
multiple of the big blind is right at 1/2 six-handed and wrong everywhere
else.

Under pot limit, every preflop raise — open, 3-bet, 4-bet, commitment-zone
raise and Omaha reshove, on both preflop paths — is now sized off that
ceiling, shaded down by at most 8% by the persona's sizing dial so the fleet
is not sizing to the cent. A PLO OPEN is additionally floored at 3x BB (3x
the straddle in a straddled pot), so a min-raise open is unreachable rather
than merely rare. The floor yields only to the pot-limit ceiling itself and
to an all-in for less, both of which are the largest legal wager available.

Measured over the scenario matrix, first in, no limpers, no straddle:
PLO now averages 3.15-3.35x BB with 0.0% min-raises; NLH is unchanged at
2.47x with 16.3% under 3x, which is the regression guard that the change is
scoped to pot limit.

`plo_pot_preflop_size` fires in `horse_brain_telemetry` on every pot-limit
preflop raise — proof of receipt that the new path is the one the fleet runs.

## The stack-off detectors

Hand #5428599 (PLO6 $1/$2, Midway Union): the horse opened 2.5x with
A-A-J-9-8-4, called a pot 3-bet, called a pot-sized flop bet, then bet the
paired turn and called off 86% of a 169 stack into a check-raise all-in from
the preflop 3-bettor. It held trip nines against sixes full. Stated
accurately: it had roughly ten outs to nines-full, so it was a thin LOSING
call and not a drawing-dead one — and the larger error was the 2.5x open
that built the pot.

This is the second instance of a shape the 2026-09-02 audit panel proposed
off hand 103011, and neither hand carried a leak tag, because the Omaha nut
block knows flushes, straights and boats and nothing on the trips or
one-pair rungs. Added to `detectLeaks`:

- `plo_naked_trips_stackoff` — Omaha showdown loss, 100bb+ invested, hero's
  final hand is trips, and the board makes a full house, a flush or a
  straight available to somebody else.
- `plo_toppair_no_redraw_stackoff` — same gate, hero's final hand is at most
  one pair. By the river every redraw has resolved, so a hand still showing
  one pair is one whose wrap, flush or nut redraw never arrived.

Counting only. No stack-off threshold and no calling range moves here: those
are STRATEGY and need scenario tests plus a league matchup with significance
(|bb100| > 2 x stderr) before anyone may claim an improvement. These tags
exist to justify or refute that work with real counts.

Pinned by `server/src/engine/HorsePloPreflopSizing.test.ts` (sizing, driven
end to end through `HorseLogic.decide` so `legalize` and the pot-limit cap
are in the path) and `server/src/services/HorsePloStackoffDetectors.test.ts`
(detectors, with #5428599 as the fixture).

Two assertions in `HorseV25.test.ts` moved with the code and are explained in
place: one pinned the layer's old `bb * 3.5` shorthand on an ante fixture
whose real pot raise is 4.5bb, the other asserted that the generic 3-bet and
the PLO reshove produce DIFFERENT sizes — they now agree, because both size
to the pot, which is the fix rather than a regression.
