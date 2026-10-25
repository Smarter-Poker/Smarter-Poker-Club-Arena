# Horses stop flatting the aggressive human's 3-bet (V53, 2026-10-24)

Dan: "PROCEED TO THE NEXT PHASE", after the V53 pressure layer went live
(bbd6db8e, serving). The next leak was read from production first (WooWoo, PLO5,
4 days, SELECT only), by preflop line, WooWoo's result per hand:

| line | hands | WooWoo per hand |
|---|---|---|
| he opens, a horse 3-bets | 92 | -14.1 bb |
| a horse opens, he 3-bets | 146 | +5.6 bb |
| limped | 116 | +5.3 bb |
| a horse opens, he flats | 388 | +2.2 bb |
| he opens, no horse 3-bet | 202 | +1.5 bb |

When a horse opened and he 3-bet, the horse's CALL lost 14.9 bb a hand (88
hands, -1,308 bb), its fold lost 4.2 bb, and its 4-bet WON 17.4 bb a hand (26
hands). The V38 maniac path flatted whenever raw equity cleared the price plus
a 3-point realization margin, and 4-bet only all in.

A river repair was considered and dropped on the same evidence: horses that
raised his river bet won +591 bb over 25 spots; calls ran -1.6 bb a spot.

## The change (read-gated, inside V38)

Hero opened, a pressure target (aggressiveBettorPressure) 3-bet it, the
3-bettor is not all in: the flat needs 10 points of realization out of
position (5 in position), and a hand clear of that bar by 6 points 4-bets (pot
in pot limit, 2.3x in no limit). Receipts `v53_pressure_four_bet`,
`v53_pressure_three_bet_priced`.

Harness (real HandController, identical decks, 600 PLO5 hands): facing the
human's 3-bet the horses went from 1 fold / 101 calls / 8 4-bets to 8 / 52 /
51, and the horses' net improved by 102 bb/100 on that seed. HorseManiacPressure
law, neutrality law and the exploit suites pass. Pinned in
HorseV53PressureBehavior.test.ts.
