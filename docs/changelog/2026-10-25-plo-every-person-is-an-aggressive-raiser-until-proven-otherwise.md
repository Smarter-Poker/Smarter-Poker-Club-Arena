# PLO: every person is an aggressive raiser until proven otherwise (2026-10-25)

Dan, verbatim: "NEW PLAYERS ARE ALL WINNING IN PLO. THIS CAN NOT HAPPEN! YOU
HAVE TO STEP UP THE HORSES GAMES IN PLO AGAINST REAL PLAYERS!!", "THIS PLAN
SHOULD BE USED FOR ALL AGGRESSIVE PLAYERS, LIKE LUCKY AS WELL", "EVERY HUMAN
PLAYER SHOULD BE TAGGED AS AGGRESSIVE, NO MATTER HOW MANY HANDED IT IS",
"FOR PLO, NOT FOR HOLDEM", "TAG THEM ALL FROM THE START, UNLESS OTHERWISE
PROVEN DIFFERENTLY", "KEEP IT PLO ONLY FOR NOW".

## What production showed (SELECT only, 2026-10-25)

PLO cash, 7 days, people with 15+ hands in a game: humans as a group lost
about 1,000 bb to the horses (about 1,300 bb on all-in equity). Seven
player/game pairs were up and fifteen down. Every winner raised 45-72% of
hands preflop: WooWoo PLO5 +2,505 bb (about half above all-in equity),
2High2Care PLO4 +531, Mikey PLO4 +481.

WooWoo's PLO5 full-ring read engaged as a maniac; his 3-5 handed read did
not (pfr 0.51 against a short-table edge of 0.46, three-bet 0.31 against
0.195, on the ~44 decayed hands the counters hold). 623 of his 1,395 PLO5
cash hands were 3-5 handed, at +2.33 bb a hand against +1.37 full ring,
and every V53 pressure line (3-bet, barrel, 4-bet or fold) was off there.

Measured from the decision onward (chips put in after the decision against
chips won), horses facing WooWoo's turn and river bets did NOT lose by
calling or shoving: turn shoves +369 bb over 57, river calls +267 bb over
49, river shoves about even over 25. The proposed "stop stacking off on the
turn and river" and "fold more to his river bets" changes would have cost
money and were not built. Flop calls lost (218 calls, -1,933 bb), at a
similar per-call rate against horse bettors at the same tables; that is a
separate follow-up.

## The changes

1. A known maniac is a maniac at every table size (all variants). A
   statistic already past this table size's envelope edge, on at least
   eight decayed opportunities, engages when the same player's read of the
   same game at the sibling size engaged it. The memory service now loads
   the sibling row for those players in the same single donor read.
   Telemetry: `opponent_exploit_corroborated`.
2. PLO presumption (Omaha family only; hold'em and Short Deck unchanged).
   For a seat the engine roster says a person plays (`humanUserIds`, a
   server-side decision input never serialised to a client), the preflop
   raise read is presumed engaged at least `MANIAC_MIN_RAISE_WIDTH` wide
   from the first hand at every size. It comes off when the person's own
   raising is credibly no higher than the average horse in that game and
   size (90% one-sided, 15 decayed hands). Every other statistic stays
   measured. Telemetry: `plo_human_presumed_aggressive`,
   `plo_human_presumption_disproved`.

## Exception to CLAUDE.md 10.5, by owner order

10.5 forbids treating a horse differently from a person. This change makes
the horse brain read a PERSON differently from a horse in PLO, by Dan's
explicit order above. It was put to him with the cost stated (an observant
player may notice horses pressing people harder than each other) and he
chose it. It denies a horse nothing a person gets. Do not remove it as a
10.5 violation; change it only on a later owner instruction.

Pinned in `server/src/engine/HorsePloPresumption.test.ts` against the
production counters above.
