# A hold'em one pair that bet the flop or turn and was raised is priced against the raise (V66)

The second and third largest measured Hold'em losses in the 2026-10-31 leak
report (`/home/claude/wt/horse-leak-report-2026-10-31.md`, leaks 2 and 3) are
the same line on two streets: the horse bets the flop or the turn with one
pair (or nothing), is raised, and calls.

## Measured first (7 days of `horse_hand_reviews`, nlh, 12% sample, |net| >= 20bb, SELECT only)

| class (horse decision)                              | seg  | n     | won   | net bb (sample) | avg raise | weekly net bb |
| --------------------------------------------------- | ---- | ----- | ----- | --------------- | --------- | ------------- |
| FLOP bet, raised, CALL with one pair or air         | cash | 1,040 | 32.8% | -28,444         | 0.86 pot  | about -241,000 |
| same                                                | MTT  | 805   | 33.8% | -19,551         | 0.86 pot  | about -163,000 |
| TURN bet, raised, CALL or call-all-in with one pair | cash | 650   | 33.1% | -21,155         | 0.78 pot  | about -179,000 |
| same                                                | MTT  | 603   | 36.0% | -13,307         | 0.70 pot  | about -111,000 |

By hand class on the flop (cash): top pair called 602 times and won 43.4%,
under pair 237 times and won 22.4%, air 201 times and won 13.4%. The horse
folded 15 of 1,196 one-pair-or-air flop decisions. Reference: a flop raise
with two pair or better wins 82%.

## What the code did (verified)

The analyst named the committed branch
(`committed = spr < 1.2 || toCall >= stack || invested ratio >= 0.3`), where
hero's own c-bet counts toward the invested ratio and the SPR, and the call
is priced at `potOdds + 0.02` with a 0.42 floor. That is true where it
reaches, but at 100bb a 2/3-pot c-bet raised 3x does not reach it (SPR 4.2,
invested 7%), and the horse still called 100% of the time. The larger cause
sits one layer up, in the equity read: the V12/V16 board-contact sampler
treats a RAISE over hero's bet exactly like a bet, ninety percent "any pair
or draw" and ten percent air. Against that range top pair top kicker on
Q-7-2 reads 87% and an under pair 46%; measured, those hands won 43% and 22%.
Every call bar downstream (the committed bar, the heuristic flop/turn line
at `potOdds + 0.03 x respect + a sizing penalty capped at 0.06`) was then
cleared by a number that was never true. `raisedAfterAggr` fed only the V21
raise discipline and the V23 plan; nothing priced the raise.

## The change (`v66BetRaisedOnePair`, default on; explicit false is today)

Single-board Hold'em (not Omaha, short deck, multiple boards or bomb pots),
flop or turn, hero bet or raised this street and now faces a raise, hero
holding the V61 bluff-catch class (one pair, or two pair through the board's
pair) or air with no real draw (`holdemRealDraw`: a flush draw using a hole
card or eight-plus straight outs keeps today's path), and no exploit read
marking the raiser as an over-aggressor (`exploit.callDownMod > 1`):

1. **The raise stratum** (`HorseEval` `raisePolar66`, receipt
   `v66_raise_stratum`). The raiser's sampled hand is drawn from a raise
   stratum through the same exact per-call band index V62 uses on the river:
   flop raise 20% bluff or semi-bluff, otherwise two pair+ 55% / top pair or
   overpair 35% / weaker pair 10%; turn raise 15% bluff, otherwise 65 / 30 / 5.
   The prior is independent of hero's hand. With it, TPTK on Q-7-2 reads
   50-51% against the raise, an under pair 25-26%, air 13%.
2. **Commitment** (`HorseLogic` committed branch). Hero's wager this street
   no longer counts: the class is committed only when the post-call SPR is
   under 1, the call is the whole stack, or hero's investment BEFORE this
   street already reached 30% of the starting stack.
3. **The raise shade** (`v66BetRaisedShade`, receipt `v66_bet_raised_one_pair`).
   `0.10 x clamp((toCall / pot - 0.25) / 0.2, 0, 1)`: zero below a quarter of
   the pot after the raise, the full ten points from 0.45. Added to the
   committed branch's required equity (beside `shade61c`), and subtracted
   from the equity handed to the V38 flop/turn verdict the way V61 subtracts
   `shade61` on the river.
4. **Call or fold at that price.** The committed branch's 0.42 floor and its
   jam do not apply to the class; off the committed branch the class is
   priced by the V38 realized-equity arithmetic (street, position) instead
   of the flat heuristic line, and it does not re-raise as a semi-bluff or
   as a scare-card bluff after its own bet was raised.

The river committed branch is untouched (V63 covers its shade; the polar62
raise case is a later change). Omaha, short deck, multi-board and bomb pots
are untouched.

## Measured on the fixture (`HorseBetRaisedOnePair.test.ts`, 40 seeds, 100bb, hero opened, bet 2/3 pot, villain raised)

| hand on Q-7-2 (flop) / Q-7-2-4 (turn) | raise | V66 on (call/fold) | V66 off (call/fold/jam) |
| ------------------------------------- | ----- | ------------------ | ----------------------- |
| AQ top pair top kicker, flop          | 3x    | 40 / 0             | 40 / 0 / 0              |
| AQ, flop                              | 4x    | 37 / 3             | 40 / 0 / 0              |
| KQ top pair, flop                     | 4x    | 5 / 35             | 40 / 0 / 0              |
| 76 second pair, flop                  | 2.5x  | 0 / 40             | 37 / 0 / 3              |
| TT under pair, flop                   | 2.5x  | 1 / 39             | 40 / 0 / 0              |
| K9 air, flop                          | 2.5x  | 0 / 40             | 7 / 33 / 0              |
| AQ, turn                              | 3x    | 39 / 1             | 40 / 0 / 0              |
| AQ, turn                              | 4x    | 9 / 31             | 40 / 0 / 0              |
| 76 second pair, turn                  | 3x    | 0 / 40             | 35 / 0 / 5              |
| AQ, turn, tournament                  | 4x    | 5 / 35             | 40 / 0 / 0              |
| AQ, turn, 40bb (post-call SPR < 1)    | 3x    | 36 / 4             | 40 / 0 / 0              |

Two pair of hero's own cards, a set, a flush draw, an open-ended straight
draw, the river, Omaha, and a one-pair hand that did not bet this street are
identical on and off (asserted).

Pin moved in the same commit: `HorsePhase8Replay.test.ts` review 399521
ablates `committedRaiseDiscipline` to reproduce the historical AA turn
re-shove; V66 also stops that jam, so the ablation disables V66 too.

## League (duplicate-deal, 8000 pairs, equity governor off; a = V66 on, b = off)

Mirror (horse field, seed 2026103107) and human-field twin (seed 2026103108):

| card          | mirror bb/100   | divergent pairs | human twin bb/100 | divergent pairs |
| ------------- | --------------- | --------------- | ----------------- | --------------- |
| nlh 100bb     | +2.26 +/- 1.31  | 120             | +3.10 +/- 1.34    | 11              |
| nlh 40bb      | +0.12 +/- 0.52  | 68              | +1.03 +/- 0.64    | 7               |
| nlh 200bb     | +1.44 +/- 2.03  | 139             | +7.14 +/- 3.18    | 14              |
| mtt 40bb      | -0.80 +/- 0.65  | 80              | +1.26 +/- 0.62    | 6               |
| mtt 25bb      | -0.30 +/- 0.34  | 54              | +0.48 +/- 0.29    | 3               |

16,000 hands per card, no illegal actions, no truncated streets. No card
below -2 standard errors, so the shade ships at 0.10. The class is rare in
the league (the horse must bet, be raised and hold one pair), so the
divergent-pair counts are small and the mirror tournament cards are inside
noise; the live review rows are the primary evidence.

## Re-measure live

Same query as the report's section 2.4 ("the same branch earlier in the
hand"): `horse_hand_reviews`, nlh, horse bet the flop/turn and faced a raise,
by hand class and action. Expect the one-pair/air call share of raised bets
to fall from 98% toward the fold rates above, and the class net to move
toward zero; two pair+ rows unchanged. Receipts `v66_bet_raised_one_pair`
and `v66_raise_stratum` in the brain telemetry count the decisions the gate
touched.
