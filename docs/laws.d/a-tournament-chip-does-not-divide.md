# server/src/engine/aTournamentChipDoesNotDivide.law.test.ts

A tournament chip is indivisible. distributePot split every pot into cents,
which is correct for cash (a chip is two decimal places) and wrong for a
tournament, where a 959-chip pot chopped two ways paid 479.50 each. The stack
sync then floored the fraction away and the settlement contract refused the
hand outright - deterministically, so every retry was identical, the engine
generation died and the table stalled. Measured 2026-09-08: 7 tournaments
carried a fractional seat and exactly those 7 were stalled. Pins that cash
still divides to the cent and is byte-identical to before, that a tournament
divides only to the whole chip, that the odd unit still goes clockwise from
the button, and that the awards re-sum to the pot exactly - including a pot
that arrived fractional from a legacy stack, where the sub-chip residue rides
with the first winner rather than being rounded away.
