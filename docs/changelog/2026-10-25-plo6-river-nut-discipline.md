# PLO6 river nut discipline on paired boards (V58, 2026-10-25)

Dan, verbatim: "YOU HAVE TO INSURE THAT HORSES ARE NOT CALLING OFF THERE
STACKS ON PAIRED BOARDS IN PLO6 WTF DID I JUST WATCH JORDAN CALLED OFF ON THE
LAST HAND" and "IN PLO6 IF ITS NOT THE NUTS, ITS PROBABLY NOT GOOD SMH. PLO6
NEEDS ITS OWN SET OF RULES AND GUIDELINES".

## The hand

Hand 48033406 (Kings Club, Classic PLO6 1/2, 2026-10-25 21:32 UTC): board
9d 4c 9c Ad 9h. The horse seated as "jordan" called a 38 flop bet and a 113
river bet into about 150, and lost to kings full of nines. All three players
in the pot were horses.

## What production showed (SELECT only)

324 PLO6 cash river decisions facing a bet on a paired board over three
hours. Each caller's hand was scored by the chance ONE random six-card hand
beats it (`omahaRiverBeatProbability`), and the decision measured from that
moment against folding (chips put in after the decision against chips won):

| decision | beaten by a random hand | spots | won | vs folding |
| -------- | ----------------------- | ----- | --- | ---------- |
| call     | under 5%                | 11    | 55% | -37 bb     |
| call     | 5-15%                   | 14    | 36% | -215 bb    |
| call     | 15-30%                  | 87    | 22% | -1,870 bb  |
| call     | 30-50%                  | 86    | 6%  | -2,322 bb  |
| raise    | 5-30%                   | 53    |     | -1,544 bb  |

A first version counted the two-card holdings that beat the hand. That
overstates a single-card threat: on 2-2-2 the top boat (tens full) is beaten
by 40 holdings, but all 40 hold the last deuce, which a six-card hand holds
about 15% of the time. The push hook's incident suites caught it (the rule
would have folded the top boat); the probability measure replaced it.

## The change

`plo6RiverNutDiscipline` runs inside the policy graph's final `wager_rules`
node, after every strategy owner, so no branch can call around it and the
graph still binds the executed action. PLO6 only, river only, complete
single board, paired board, facing a bet:

- beaten by a random hand 15% of the time or more: fold, unless the call is
  under 10% of the final pot (then it is kept, never raised);
- beaten 5% or more: a raise becomes a call;
- stronger hands, the nuts included, are untouched.

On hand 45872846's 2-2-2 river: jacks full (beaten ~41%) folds, tens full
(~15%, only the last deuce) calls without raising, quads raises.
`omahaRiverBeatProbability` samples 20,000 six-card hands from a private
stream seeded by the cards, so a spot always answers the same and the shared
horse random stream is never touched. Switch `v58Plo6RiverNuts`, default on;
nightly league matchup `plo6_v58_river_nuts`. Telemetry
`v58_plo6_river_fold`, `v58_plo6_river_raise_to_call`.

Tests updated by this owner ruling: the PLO6 cases of
`HorsePloTripBoardIncident.test.ts` (PLO4, PLO5 and PLO8 keep the original
"flat, do not raise" ruling), the V40 aces-up comparison (its V40-off arm now
isolates V40 from V58), and the historical opponent-exploit neutrality replay
(V58 is independent of reads and switched off there, as earlier independent
rules are).

The existing `v15Boats` rule stays off by default; it measured +0.11 bb/100
(stderr 0.06) in PLO5 over 30 days and was never measured in PLO6.

Pinned in `server/src/engine/HorsePlo6RiverNuts.test.ts`.
