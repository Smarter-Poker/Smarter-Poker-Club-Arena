# Horses pressure the aggressive human: 3-bets, check-raises, river bluffs (V53, 2026-10-24)

Dan: "HORSES NEED TO 3BET AGGRESSIVE HUMANS MORE IN POSITION AND CONTINUE THE
PRESSURE THROUGHOUT THE HAND", "NOT NEARLY ENOUGH CHECK RAISES WITH THE BEST
HAND AND AS BLUFFS WHEN ITS WARRANTED", "DON'T FORGET THE RIVER BLUFF WHEN THE
SCARE CARD COMES ... NEVER BLUFFED ON THE RIVER ONCE", and "THIS MUST BE
ACTIVATED AND USED BY EVERY SINGLE HORSE ACROSS ALL GAMES".

## What the hands said (production, SELECT only)

WooWoo, 849 PLO5 hands against the fleet, 2026-10-23..24: +975 chips
(+64 bb/100), VPIP 77%, PFR 51%. All of it came from river aggression: +3,942
in the 70 hands he bet or raised the river, -2,967 in every other hand.

- Horses that 3-bet his raise won 61 of those pots to his 40; horses that
  flatted (581 times) won 176 to his 244. Horses re-raised 15% of the time
  they continued.
- Raising his flop/turn bet won 13 of 14 pots; calling his turn bet won 35 of
  84. Horses that had checked check-raised his flop bet 5.6% (12 of 213).
- First to act on the river with him still in, horses bet 21% (115 of 539) and
  he folded 85 of the 115. A three-quarter-pot bluff needs 43%.
- His live PLO5 read (horse_exploit_profiles): raises ~55% of hands, re-raises
  ~39% (shrunk posteriors, both engaged), calls ~28% of river bets on a thin
  sample; river-fold lower bound ~0.62.

## What changed (`v53Pressure`, default on)

All read-gated: nothing changes unless the opponent's exploit read is engaged,
so horse-versus-horse play is identical (HorseOpponentExploitNeutrality law
passes on its recorded corpus).

1. **3-bet the wide opener** (HorseOpponentExploit.aggressiveOpenerPressure,
   HorsePreflop): heads-up against a credibly wide opener the value 3-bet takes
   the top 45% of their range in position (38% out of position; hold'em 50/42),
   and the V16/V46 "take a flop" flats give way to the 3-bet.
2. **Raise the wide bettor** (aggressiveBettorPressure): heads-up flop/turn
   against a preflop maniac, an over-bettor or a postflop maniac, the value
   raise bar drops 8 points and fires at least 85% of the time once cleared
   (every V15/V21 domination gate still applies); the semi-bluff check-raise
   band widens to 0.60 equity and fires 1.6x as often (2.5-4x into a credible
   over-folder), into bets up to the pot.
3. **River bluff the over-folder** (riverFoldLowerBound, riverBluffFrequency):
   with no showdown value, heads-up, hero bets 62-75% pot when the opponent's
   credible river-fold lower bound (80% credibility; the postflop fold read
   when the river sample is thin) clears the bet's break-even by 6 points (12
   after two called barrels), more often on a scare card.
4. **Every horse, every game.** The live engine and Lightning send no option
   overrides, so the default applies to every horse decision. The hold'em V31
   solver consult hands a V53 target to the exploit layer, and the tournament
   utility arbiter prices a river bet with the same river-fold read, so neither
   can veto these lines.

## Measured on the real HandController

`HorseAggressiveHumanPressure.test-support.ts`: five horses against a model of
the human (opens 76%, re-raises 48%, never folds to a 3-bet), identical decks
per arm. Over 2 x 2,000 PLO5 hands the horses 3-bet his open 466/473 times
with V53 against 248/242 without, and flatted 334/318 against 549/545. Net chips
in that model were inside the noise (one seed -67, the other +63 bb/100): the
model human loses to the fleet either way, so it measures the lines, not the
real edge. The nightly league gains v53_pressure (hold'em) and
plo4/plo5/plo6_v53_pressure; the live read is the post-launch check.

Pinned by `HorseV53Pressure.test.ts` and `HorseV53PressureBehavior.test.ts`.
