# Hold'em one-pair river calls are shaded against the price (V61)

Dan, 2026-10-24: "YOU'VE GOT TO MAKE THESE HORSES KILLERS. THEY ALL NEED TO
BE WINNING PLAYERS". The largest measured Hold'em loss is not a bet the
horses make; it is the river call they make with one pair.

## Measured first (14 days of NLH review stack-offs, SELECT only)

Horse one-pair, top-pair-weak-kicker and board-paired two-pair hands that
called (or called all in) a river wager, by the price faced, horse-vs-horse
and human-seated alike:

| price (to call / pot)   | cash n / net bb / win | tournament n / net bb / win |
| ----------------------- | --------------------- | --------------------------- |
| under a quarter         | 1,016 / -61,502 / 18% | 743 / -43,630 / 17%        |
| a quarter to a half     | 4,597 / -230,082 / 22% | 2,589 / -124,531 / 21%    |
| a half to a full pot    | 2,299 / -146,979 / 14% | 1,238 / -77,580 / 14%     |

The price demands roughly 20, 29 and 40% at those rows. The same hands that
bet or raised the river for value won 54-69% of the time, so the range the
call is priced against is the error: it holds far more bluffs than the fleet
and its opponents actually fire. -684,000bb in cash and -246,000bb in
tournaments across the table above.

## The change (`HorseLogic.ts` V38 river block and committed branch, `v61RiverOnePairShade` default on)

Single-board Hold'em (not Omaha, short deck, multiple boards or bomb pots),
facing a river wager, hero holding at most one pair, or two pair that shares
the board's pair, and no exploit read marking the bettor as an over-bluffer
(`respect < 1` keeps the unshaded call-down): the equity handed to the MDF
river verdict drops by `min(0.12, max(0, (toCall/pot - 0.2) x 0.4))`: nothing
under a fifth of the pot, where the measured calls were about break-even, and
the full twelve points from half a pot, and the committed
branch (hero bet the river and was raised, or the stack is mostly in) adds the
same shade to its required equity: after betting the river, one-pair calls of
the raise won 14-15% at an average price of 0.38 (-178,000bb over the same 14
days) while better hands won 35-37%. The value-raise branch and the V51 river
flat are untouched; a credible
bluffer is still called down; the explicit off arm keeps the V38 verdict.

Telemetry receipt `v61_river_one_pair_shade`. Pinned by
`HorseRiverOnePairShade.test.ts` (shade size, tournament and ace-high
coverage, sets/two-pair/Omaha excluded, off arm). The exploit-neutrality corpus,
the pre-candidate tournament corpus digests and the captured Phase 8 replays
(review 399839 is itself an overpair paying off a river jam) carry the
explicit off arm, as V57 and V58 did, so recorded receipts keep their meaning. This is a measured calibration of the
call price, not a range-model repair (checklist item 13) and not a held-out
profit certificate; the live re-measure is the same table after activation.
