# Tournament horse aggression, Phase 1 of 4: shove discipline

Dan, 2026-10-25, after real players called the tournament horses "the most
passive scared players they have ever played with": "WE HAVE TO PUMP THE
AGGRESSIVE NUMBERS UP, AND BIGGER STACKS SHOULD NOT BE OPEN RIPPING 35+ BIGS
UTG OR PERIOD! THIS NEEDS A FULL ENHANCEMENT PHASE".

## What production showed (NLH tournaments, horse decisions)

Human-seated tournament hands, last 48 hours:

| | horses | humans |
|---|---|---|
| VPIP / PFR | 19.9 / 14.8 | 47.3 / 17.3 |
| fold to an open | 82.4% | 52.0% |
| 3-bet | 5.5% | 11.5% |

Shoves, last 24-48 hours:

- heads-up Sit & Gos open-shoved 93% of first-in hands at 20-25bb and 64% at 25-35bb; Spins 59% at 25-35bb;
- MTT stacks of 20-25bb open-shoved 26% of first-in decisions;
- 50-130 re-raise shoves a day at 35bb+ effective; the 3-bet shoves were AA/KK/QQ/AK for 35-100bb, and 70 5-bet shoves in 30 hours at 100bb+ (QQ/JJ/TT/AK among them) averaged -18bb.

## The change

`server/src/engine/HorseTournamentShoveDiscipline.ts`, run inside the
`wager_rules` node of the decision graph and again at commit in
`ServerTableEngineTurns`, so it holds whichever owner (reference, Phase 7
utility, joint node) proposed the shove:

- first in: shove only at <= 20bb effective (20, not 15: the 2026-10 maniac law keeps a 20bb stack shoving rather than raise-folding into a jammer behind); deeper opens 2.2x (+1bb per limper);
- over one raise: shove only at <= 25bb; deeper 3-bets to 3x (3.5x from the blinds, +1x per caller);
- over a 3-bet: shove only at <= 40bb; deeper 4-bets to 2.25x;
- a standard raise that already commits 40% of the effective stack stays a shove;
- a stack that covers every live opponent raises to exactly what the biggest of them holds.

`HorsePreflop` gains `effectiveStackBB` and a deep 5-bet gate: facing a 4-bet
at 60bb+ effective in a tournament, only AA/KK shove; other strong hands call
a small price or fold.

Untouched: cash games, pot limit, fixed limit, all-in-or-fold tables, postflop,
and call-offs where nobody behind can act.

Pinned by `server/src/engine/HorseTournamentShoveDiscipline.law.test.ts`.
Engine change: activates at the daily 04:00 Chicago engine maintenance.
