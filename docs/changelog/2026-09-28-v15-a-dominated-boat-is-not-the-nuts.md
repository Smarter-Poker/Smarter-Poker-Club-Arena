# 2026-09-28 - V15: an Omaha full house a bigger boat beats is not the nuts

## What the audit found

The 2026-09-27 horse audit's showdown sweep found two horses re-raising a river
raise with an under-full house:

| hand   | variant | holding              | board          | beaten by             |
| ------ | ------- | -------------------- | -------------- | --------------------- |
| 759863 | plo5    | sevens full of kings | 7c 3c 7d 7s 8s | any seven (quads), 88 |
| 755677 | plo4    | tens full of deuces  | Tc 2h Ah 2c Qh | AA, QQ, 22            |

Replayed through `HorseLogic.decide()` at the same river spot (hero bets,
villain raises), the current brain raised or jammed on 73% and 74% of 300
seeds.

## Cause

V15 classes a hand as nut-class with `cat >= 7 || ...`: every full house is
the nuts, whatever the board. The V15 equity cap exempts full houses outright,
and the V21 river raise-war governor skips Omaha (`!vi.isOmaha`). So nothing
evaluates an Omaha boat against the bigger boats the board makes possible.

The same audit read a falling `v15_nut_status / decide_omaha` as "V15 gate
decay". That series is diluted by preflop decisions, which can never fire V15.
Against `banded_mc_omaha` (postflop Omaha equity runs) the rate held at
11.1-12.1% from 2026-09-17 to 09-26 and dipped to 9.6% on 09-27, the day PLO6
volume halved and PLO4 rose by half. No gate is proven broken; the breaches
are this rule, not a missed gate.

## Change (behind `opts.v15Boats`, default OFF)

- `omahaBoatsAbove(hole, board)` counts opponent two-rank holdings that make a
  bigger full house, and those that make quads, playing exactly two hole
  cards and three board cards.
- A boat is dominated when any bigger boat is live, or quads are reachable by
  two or more holdings. Aces full on 9-9-x, beaten only by pocket nines, is
  still the effective nuts.
- A dominated boat is not nut-class. Raised after it bets, it calls: it never
  re-raises or jams. Unraised, it plays exactly as before.

Replayed with the flag on, both audit hands call on all 300 seeds. The
aces-full control and the unraised spots are unchanged seed for seed.

## Why default OFF

This changes strategy, so it is measured before it ships: a new league matchup
`plo5_v15_boats` plays the flag on against today's brain. It ships default ON
only after that matchup resolves significant positive (|bb100| > 2 \* stderr).

Pinned by `server/src/engine/HorseOmahaBoats.test.ts`, including a test that
fails if the default changes without that measurement.
