# Horses read each opponent at the table and exploit them (2026-10-16)

Dan, verbatim: "HORSES are not table aware of how their opponents are playing
against them. I'm raising and potting at a 100% VPIP and raise frequency and
the horses are not adjusting to that or taking this into account for their
decision making process."

## Why they did not adjust (read from the code and production)

- The only read at decision time was HorseMind's LIFETIME counters. VPIP, PFR
  and 3-bet never decay, and below 40 scoped hands the pooled bucket (every
  game, cash and tournament) answers. Dan's stored row (user 47965354): 761
  pooled hands, VPIP 39.8, PFR 29.8, fold-to-aggression 65%, AF 1.18. In his
  short-handed Omaha scope (28 hands) that pooled row answered: bluffMod 1.45
  (bluff him MORE), no call-down adjustment.
- Preflop facing an open, the call and 3-bet bars depended on the raiser's
  SEAT only. Nothing widened against a wide opener.
- The postflop bluff read mixed preflop folds into fold-to-aggression, so a
  tight-preflop history got a postflop maniac bluffed more. Multiway, the
  call-down read was the table AVERAGE.
- Last five days of cash, horses facing a single open: NLH vs Dan
  fold/call/3-bet 88.2/9.8/2.0 (n=51) vs horses 73.7/22.1/4.2 (n=190);
  Omaha vs Dan 75.3/23.5/1.2 (n=81) vs horses 59.8/31.8/8.3 (n=132).

## What changed

`server/src/engine/HorseOpponentExploit.ts` (new, pure) reads each opponent
from DECAYED counters (half-life 30 completed hands, per read scope, memory
only, carried in the decision read frame so the second look sees the same
read): VPIP, PFR, raise-first-in, 3-bet, fold-to-3-bet, bet when checked to,
POSTFLOP fold to a bet, river call. Every statistic is a Beta posterior shrunk
to the horse-population mean (prior strength 6). It engages only when its
one-sided 90% credible bound clears the measured horse envelope plus 0.03,
and only on the side that matters (looser / more aggressive / stickier, plus
the over-folder). A fresh 100% raiser is read within 8 hands in every variant
at 3+ seats (`HorseOpponentExploit.test.ts`), on top of Dan's real stored
761-hand row too.

When an opponent is engaged:

- Facing their open: value 3-bet the top 40% (Omaha 30%) of what THEY open,
  flat the top 70% (big blind 85%); no bluff 3-bets or squeezes into a player
  who does not fold to them; 4-bet and call wider against an over-re-raiser;
  isolate a loose limper wider.
- Range reads (`bandFor`) use their measured width, and an over-aggressor's
  barrels narrow the read less.
- Bluffs are priced from POSTFLOP-ONLY fold-to-bet (x0.3 to x0.75 into a
  station, up to x1.5 into an over-folder); value bets are thinner and bigger
  into a station; strong hands trap more against an aggressor; the CURRENT
  bettor's own read prices the call (up to ~4 equity points), not the table
  average; tournament fold multipliers pick the same read up.
- The PLO4, PLO5/6/8 and remaining-variant pack deviations (wagers into an
  opponent-blind horse field) stay out against a station; the reference,
  which carries the read, decides.

Applies to NLH, PLO4/5/6/8, FLH, FLO8, Short Deck and Pineapple, cash and
tournaments. The Phase 13 joint path is shadow live (no selection), so it
decides no live action; its tournament fold multipliers read the same layer.

## The population envelope (measured, not guessed)

Production, SELECT only, every hand logged 2026-10-15T17:30Z..16:30Z:
1,186,859 hands, 3,187,553 horse seat-hands, 1,000 horses, read from
`hand_history.actions` with the query recorded in the module and run through
the exact live counting code. Per (game, table size): pooled horse mean;
band = P1-P99 of per-horse rates (horses with 40+ opportunities, when 30+
qualify), else a method-of-moments beta-binomial spread (+/- 2.33 sd,
floored at 0.08), else +/- 0.20 for games few horses play. Version
`horse-population-2026-10-16`.

False engagement, replaying every horse's own real sequence through the
decayed counters and the gate: 2,023 of 3,187,553 seat-hands (0.063%). NLH
0.085%, PLO4 0.024%, PLO5 0.059%, PLO6 0.004%, PLO8 0.27%, FLH 0%, FLO8
0.008%, Short Deck 0%, Pineapple 0.017%. Simulated horse styles across every
band: under 1% (`HorseOpponentExploit.test.ts`).

Dan's own 248 logged hands since 2026-10-09, replayed: the read engages at
his 9th hold'em full-ring hand and his 17th Omaha full-ring hand.

## Proof that horse-versus-horse play did not change

`HorseOpponentExploitNeutrality.law.test.ts` replays a corpus RECORDED FROM
MAIN 8b7d96f9 BEFORE the layer existed: 74,915 decisions, all nine variants,
cash and tournament, every seat a horse, one HorseMind learning over 600
hands per run. Action, amount and the random-stream position after every
decision are chain-hashed every 50 decisions. While no opponent is engaged
the replay must be identical link for link. On this branch no opponent read
engages anywhere in the corpus, and the full replay is identical on all 18
runs (HORSE_NEUTRALITY_FULL=1).

The locked strength matrices are inert to the layer by construction (a fresh
HorseMind sandbox per hand). Shard 0 of each locked contract was rerun in
contract mode on main 8b7d96f9 and on this branch before the river-probe
patch (4d2350e3), and every result field but the wall-clock duration is
identical, pair digest included:

| matrix   | shard                                   | pairs  | decisions | pair digest |
| -------- | --------------------------------------- | ------ | --------- | ----------- |
| P10 PLO4 | p10c-6max-2dealt-100bb-10201109-s0      | 23,040 | 150,923   | 6a5ee401... |
| P11 PLO5 | p11c-plo5-6max-2dealt-100bb-11201117-s0 | 9,792  | 70,935    | e9b1aece... |
| P12 FLH  | p12c-flh-6max-2dealt-100bb-12401129-s0  | 12,960 | 114,209   | 6acd4e29... |
| P13 NLH  | p13c-nlh-3dealt-100bb-13211143-s0       | 45,360 | 416,152   | 8e25db51... |

The river-probe patch (below) deliberately changes river play for every
horse, so the requalification runs on the final commit measure it too.

## Measured against an always-pot-raise seat (paired, same state, same random position)

`HorseOpponentExploitBehavior.test.ts` (the test plays 100 hands per run; this table is a 300-hand run of the same harness), layer on vs off:

| run             | fold to its open | value 3-bet  | river call   |
| --------------- | ---------------- | ------------ | ------------ |
| NLH cash        | 0.78 -> 0.36     | 0.08 -> 0.33 | 0.57 -> 0.86 |
| PLO4 cash       | 0.62 -> 0.51     | 0.04 -> 0.15 | 0.50 -> 0.50 |
| PLO5 cash       | 0.61 -> 0.49     | 0.06 -> 0.24 | 0.57 -> 0.57 |
| PLO6 cash       | 0.53 -> 0.46     | 0.08 -> 0.23 | 0.67 -> 0.67 |
| PLO8 cash       | 0.65 -> 0.55     | 0.03 -> 0.12 | 0.45 -> 0.55 |
| FLH cash        | 0.68 -> 0.33     | 0.09 -> 0.33 | 0.61 -> 0.89 |
| FLO8 cash       | 0.51 -> 0.48     | 0.03 -> 0.13 | 0.74 -> 0.85 |
| Short Deck cash | 0.74 -> 0.29     | 0.07 -> 0.36 | 0.46 -> 0.54 |
| Pineapple cash  | 0.76 -> 0.29     | 0.08 -> 0.37 | 0.08 -> 0.54 |
| NLH tournament  | 0.79 -> 0.40     | 0.08 -> 0.31 | 0.20 -> 0.60 |
| PLO5 tournament | 0.60 -> 0.47     | 0.05 -> 0.22 | 0.57 -> 0.57 |
| FLH tournament  | 0.68 -> 0.37     | 0.08 -> 0.30 | 0.65 -> 0.90 |

Heads-up spot tests: strictly more traps against the maniac, strictly fewer
bluffs into a calling station, and the second look decoded from the read
frame makes the same decision.

## Also in this change

- The digest hole is closed: HorseLogic's own decision modules (HorsePreflop,
  HorseEvEngine, the solver charts and consults, the tournament preflop atlas
  and Phase 8 owner, HorseVariantProfile, HorsePersona, IcmModel, ...,
  HorseOpponentExploit) enter the Phase 10 (v3), 11 (v5), 12 (v2) and 13 (v2)
  digests; `HorseReferenceDecisionSources.test.ts` keeps the list equal to
  HorseLogic's real imports.
- The default persona follows the solver line (gtoAdherence 1; G4).
- The held v17 river-probe patch (default off) is applied; its audit migration
  is re-reserved as 20261016182539.

## What this costs, and what is not verified

- The PLO4 (Phase 10), PLO5/6/8 (Phase 11) and FLH (Phase 12) live
  selections no longer match the running policy digest. They are refused
  `policy_digest_mismatch` and run shadow until their locked matrices
  requalify this source. Nothing re-points a digest.
- The decayed counters are memory only (no migration). Each worker learns
  the tables it serves and forgets at restart (the hourly break); the read
  re-forms within about 8 hands.
- Heads-up, horses themselves open very wide (PLO HU raise-first-in up to
  99%), so a 100% raiser is distinguishable there from PFR and VPIP only,
  later than at 3+ seats.
- Not measured: bb/100 of the exploit against a live human field; the A/B
  above is decision frequencies, not results.
