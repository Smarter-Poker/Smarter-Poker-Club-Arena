# server/src/engine/aDiamondDoesNotDivide.law.test.ts

A Diamond is one indivisible unit, and every guard on the Diamond path REFUSES
a fraction rather than flooring it - so a divide that lands on half a Diamond
does not lose money quietly, it stops the hand, deterministically, and every
retry stops it again. That is how run it twice was closed for Diamond from
Phase 6 to Phase 7: the per-board slice was cut in cents, a five Diamond pot
over two runs paid 2.5 a board, and the table would have dealt a hand it could
never settle. Pins the four dividers a Diamond pot can meet - the
run-it-twice per-board slice, the multi-board settlement, the tie chop inside
one board and the payout unit - to one rule: every chop pays whole Diamonds and
re-sums to the pot, every slice partitions exactly with the odd unit to the
earliest board, a pot too small to reach every board pays the earliest rather
than nobody, the odd Diamond inside a chop goes to the first seat clockwise of
the button, and cash still divides to the cent. Then pins each divider to
READING the asset, because a fifth divider written in cents would pass every
arithmetic case above and still deal a hand that cannot settle.
