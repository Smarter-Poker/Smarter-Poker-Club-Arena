# Horses bluff the river, only when it makes sense (V54, measured before it ships)

Dan, 2026-10-24 16:21 Chicago: "a player just said to me, i've never once seen a player bluff on the river, the bluff shove or big bet bluff needed to be implemented ONLY WHEN IT MAKES SENSE."

## Why there were no river bluffs

`HorseLogic.decidePostflop` had no layer that chose a river bluff on purpose. With no bet to face, the only river bets made with air came from two generic ladders. One is the V7 barrel continuation (`0.35 x min(1.25, bluffScale)`, and given up 80% of the time with no plan). The other is the pure-bluff roll (`bluffFreq x min(1.3, bluffScale) x 0.55`, about 0.09 for a balanced horse). Both were sized at 0.45-0.8 pot. On top of that, `bluffScale` was trimmed on the river by V40 (`v40_no_third_barrel`, x0.15 in Omaha after two called barrels), V36 (`v36_multiboard_bluff_trim`), V23 river reads and V17 position. The V29/V30 solver consult answers first where it has a cell. Production telemetry for the last two days shows these suppressors firing tens of thousands of times a day, and no deliberate river-bluff feature at all. On the calling side, the river fold verdict (`v38_river_fold`) and the overbet/big-bet caps (`v19_*`) are the matching defences. The league measured `tuner_bluff_up` slightly negative, so a flat "bluff more" knob is wrong.

## What V54 does

`v54RiverBluff` (default OFF, production unchanged) owns one spot. All of these must hold:

- the river, with no bet to face (checked to hero, or hero first in), and exactly one opponent who can still call (not all in);
- a single board;
- air: under 20% equity against the opponent's read range;
- a value story: hero bet the turn and was flatted, or the river card tells it (Omaha: the made-range read says the card improves hero's range or hands hero the nuts; any game: a scare card hero blocks, on ranges that favour hero) after hero held the lead or the turn checked through;
- a capped opponent: no turn aggression, no raise anywhere postflop, no runout read favouring the opponent, and in Omaha not two called pot barrels unless the river moved the ranges hero's way (the V40 rule);
- the blocker that matters: Omaha needs the nut blocker; Hold'em takes a nut-flush or top-straight blocker, or the missed-flush unblocker;
- not a calling station by memory (a credible station read, fold-to-river-bet under 35%, or a lifetime fold read that cuts bluffs). Against a station it always checks;
- an effective stack of at least half the pot;
- in a tournament, no survival pressure (satellite, or ICM premium of 0.05+, or 0.03+ for a shove).

When all of these hold, the bet is sized as follows: the pot in pot limit; the shove in no limit when the effective stack is at most 1.5 pots; otherwise 0.75-1.0 pot, or a 1.0-1.5x overbet when hero holds the nut blocker and the river gave hero the range or nut advantage. The frequency is capped so bluffs stay within the game-theory share s/(1+2s) of hero's river betting range at that size. Hero's public river range is sampled against the opponent's on the exact board (`estimateRiverRangeComposition`, deterministic and consuming no decision RNG). The cap is never more than s/(1+s), at most one air combo in two at pot, because the preflop bands cannot see a barrelling range's missed draws. It is then scaled by the read: 1.0 against a known folder, 0.8 neutral, 0.6 unknown, and x0.75 when the river did not favour hero. A spot that fails the roll checks. Every other spot falls through to the existing layers untouched.

Telemetry: `v54_river_bluff` when it bets, and `v54_river_bluff_skip_<reason>` for multiway, multiboard, all_in, showdown_value, station, no_story, uncapped, no_blocker, short_stack, icm, illegal and frequency. These are registered in the data ledger with no floor while the flag is off.

## Measurement

The nightly league gains `v54_river_bluff` (Hold'em) and `plo4_/plo5_/plo6_v54_river_bluff`. Arm A turns the flag on and arm B is production (the v16Hu pattern), and the legacy all-off arm lists the flag. Under Dan's rule, it goes live for every horse once it beats the current brain there. In self-play the spot is rare (most heads-up checked-to rivers still hold showdown value), so a card needs its full 6,000 pairs to resolve.

Tests: `server/src/engine/HorseV54RiverBluff.test.ts` covers eligibility, every decline reason, sizing, the frequency cap, determinism, and flag-off decisions that match the pre-V54 brain byte for byte (`HorseV54RiverBluff.golden.json`). `server/src/benchmark/HorseV54RiverBluff.test.ts` pins that the cards are not inert.
