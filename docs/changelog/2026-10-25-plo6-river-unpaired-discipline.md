# PLO6 river discipline on boards with no pair (V59, 2026-10-25)

Dan: "IN PLO6 IF ITS NOT THE NUTS, ITS PROBABLY NOT GOOD" and "PLO6 NEEDS ITS
OWN SET OF RULES AND GUIDELINES". V58 covered paired boards. This is the second
PLO6 rule: the same discipline on a board with no pair, where straights and
flushes are the nut hands.

## What production showed (SELECT only)

373 PLO6 cash river calls and raises facing a bet, two hours on 2026-10-25,
every player's dealt cards read from `ca_hand_facts` (hand history records
only the hands that were shown, and a losing caller may muck, so reading cards
from there makes river calls look like winners). Each hand was scored by the
chance one random six-card hand beats it (`omahaRiverBeatProbability`) and
measured from the decision against folding:

| decision, board with no pair | beaten by a random hand | spots | won | vs folding |
| ---------------------------- | ----------------------- | ----- | --- | ---------- |
| call                         | 15-30%, no flush board  | 39    | 56% | +297 bb    |
| call                         | 15-30%, flush board     | 15    | 40% | -69 bb     |
| call                         | 30-50%                  | 58    | 17% | -754 bb    |
| call                         | 50%+                    | 19    | 11% | -173 bb    |
| raise                        | 15%+                    | 13    | 0%  | -484 bb    |

Almost every river bettor in the sample was another horse; five were people.

## The change

`plo6RiverNutDiscipline` (the policy graph's final `wager_rules` node) now
also runs on a complete PLO6 river board with no pair, with its own lines:

- beaten by a random hand 30% of the time or more: fold to the bet, unless the
  call is under 10% of the final pot;
- beaten 15% or more: a raise becomes a call;
- stronger hands, the nuts included, are untouched.

On Kd 9c 4h 2s Jd, top two pair (beaten ~38%) folds, top set (~21%) may call
but never raises, and the Q-T straight raises. On Kh 9h 4h 2s Jd a six-high
flush (~33%) folds, a jack-high flush (~17%) that the brain raised in 15 of 60
deals calls instead, and the queen and ace flushes are left alone.

Switch `v59Plo6RiverUnpaired`, default on; paired boards keep
`v58Plo6RiverNuts`. Nightly league matchup `plo6_v59_river_unpaired`.
Telemetry `v59_plo6_river_unpaired_fold`,
`v59_plo6_river_unpaired_raise_to_call`. Pinned in
`server/src/engine/HorsePlo6RiverNuts.test.ts`.

Test updated by this owner ruling: the PLO6 case of
`HorseOmahaRiverTripsFlat.test.ts` (V55). Its set of aces on 4c 3s 7d Jc As is
beaten by a random hand ~32% of the time (any 5 with a 2 or a 6), so it now
folds to the pot-sized river bet; with `v59Plo6RiverUnpaired: false` it keeps
V55's flat call, and PLO4 and PLO5 keep V55's ruling unchanged.
