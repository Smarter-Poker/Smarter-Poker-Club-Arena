# Tournament horse aggression, Phases 2 and 3 of 4

Follows Phase 1 (shove discipline, PR #8092). Dan, 2026-10-25: "WE HAVE TO
PUMP THE AGGRESSIVE NUMBERS UP".

## Measured first (48 hours of human-seated NLH tournament hands)

| | horses | humans |
|---|---|---|
| fold to a single open (any seat) | 82.4% | 52.0% |
| 3-bet | 5.5% | 11.5% |
| small blind fold to an open | 87-91% | 44-59% |
| <=25bb big blind fold to an open | 53% | 41% |
| fold to a 3-bet after opening | 61.7% | 39.4% |
| turn bet after betting the flop | 23.9% | 47.2% |

## Phase 2: preflop (`HorsePreflop.ts`, NLH tournaments only)

- Re-raise ranges stated as hand shares against the opener's real width:
  small blind vs a steal top ~20%, big blind vs a steal ~12%, button/cutoff vs
  a late open ~11%; early opens 3-bet a little wider.
- Big blind defends wider: -0.04 on its floor, -0.06 at <=25bb.
- Opens: small blind -0.08 (much wider), cutoff/button -0.03, others -0.02.
- Facing a 3-bet up to 60bb effective: call bar -0.02, 4-bet bar -0.015, 4-bet
  bluffs x1.5. A larger cut (calling bar 0.62) was measured and rejected: the
  early opener called 3-bets with ~90% of its range.
- Re-steal bluff volume x1.3.

Offline probe (6-handed, 40bb, no ante, before -> after): SB vs button open
fold 87.7 -> 83.1 (3-bet 7.6 -> 16.9); BB vs button open fold 47.9 -> 36.3;
20bb BB fold 48.1 -> 28.1; button vs cutoff 3-bet 6.8 -> 10.5; cutoff vs UTG
3-bet 3.1 -> 7.3.

## Phase 3: turn barrels (`HorseLogic.ts`, NLH tournaments only)

A flop bluff plans a second barrel 50% of the time (was 35%), a planned turn
barrel continues at 0.66 (was 0.52) and river 0.42 (was 0.35), and an
unplanned stab gives up 65% (was 80%). The ICM premium still scales every
bluff through `bluffScale`. Cash keeps its duplicate-deal-tuned numbers.

Phase 4 re-measures every row above on live tables after the 04:00 engine
activation.

Pinned by `server/src/engine/HorseTournamentPreflopAggression.law.test.ts`.
