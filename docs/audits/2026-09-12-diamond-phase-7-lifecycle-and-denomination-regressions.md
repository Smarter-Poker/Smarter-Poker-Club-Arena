# Diamond Phase 7: Lifecycle And Denomination Regressions Across Configurations

Status: Complete For Phase 7 Checklist Line Seven, For Every Configuration The Arena Can Open Today. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## Why This Needed Doing Now

Until September 12 a Diamond table had exactly one shape: plain NLH, every optional feature off. A regression suite for that is a regression suite for one row. Straddles arrived that day and run it twice with them, so the arena now has a matrix, and the reason line seven exists is that a matrix is where a feature quietly stops working in one cell while the cell everybody tests keeps passing.

The denomination half has a sharper reason. A Diamond is one indivisible unit and every guard on the path REFUSES a fraction rather than flooring it, so a divide that lands on half a Diamond does not lose money quietly - it stops the hand, deterministically, and every retry stops it again. That is precisely how run it twice was closed for Diamond: the per-board slice was cut in cents, a five Diamond pot over two runs paid 2.5 a board, and the table would have dealt a hand it could never settle.

## Four Dividers, One Rule

A Diamond pot can meet four divisions on its way to a stack:

1. the run-it-twice per-board slice, in `ServerTableEngineRunout`;
2. the multi-board settlement, in `HandController`;
3. the tie chop inside one board, in `PokerEngine.determineWinners`;
4. the payout unit at the end of a hand, in `HandController`.

`server/src/engine/aDiamondDoesNotDivide.law.test.ts` pins all four to the same rule. The arithmetic cases are the property: every chop of every pot from 1 to 300 pays whole Diamonds and re-sums to the pot; every slice for two and three runs partitions exactly with the odd unit to the earliest board; a pot too small to reach every board pays the earliest rather than nobody; the odd Diamond inside a chop goes to the first seat clockwise of the button; and the cash rule is exactly where it was.

The source pins after them are the regression, and they are the point of the file. A fifth divider written in cents would pass every arithmetic case above, because those call the arithmetic directly, and would still deal a Diamond hand that cannot settle. Each divider must READ the asset, and the file says so of each one by name.

## Every Configuration The Arena Can Open

`server/src/engine/DiamondTableConfigurations.test.ts` is the matrix. Six shapes - plain, voluntary straddle, mandatory UTG straddle, run it twice by the pair of columns, run it twice by the third column, and straddles with run it twice together - crossed with the four live statuses, and each one admitted. The same six crossed with the five terminal statuses, and each one refused.

Then the stake ladder. Dan set it on September 11: the Club Arena NLH stakes at one Diamond to the cent, seventeen rungs from 1/2 up to 5000/10000. Every rung is admitted in every shape, and at every rung a full three-handed hand is dealt at the maximum buy-in and conserves to the unit with every stack a safe integer. A denomination regression that only tries 1/2 proves nothing about 5000/10000, where a buy-in is two million Diamonds and every guard is a thirty-two bit check.

Then twenty-three reasons a configuration is refused - insurance, a bomb pot, the side bet, a nit game, all in or fold, pineapple, a betting cap, a template, a variant, a tournament id, a cluster id, rake, a rake cap, a jackpot percentage, three unset deduction columns, two unset run-it columns, a fractional blind, a zero minimum, an infinite maximum and a fractional ante - each asserted against all six permitted shapes, because a permitted flag must never launder a forbidden one.

## The Table Keeps Its Boundary While It Runs

`refreshRakeConfig` re-reads the table row roughly once a minute and applies it. That is right for a chip club and was a hole for an arena table, because admission was the only other place the boundary was checked.

The answer is not to freeze an arena table. A staff door may legitimately turn straddles or run it twice on for a table that is already running, and both are inside the boundary now, so those refreshes should land and the table should pick them up without a restart. `server/src/engine/aDiamondTableKeepsItsBoundaryWhileItRuns.test.ts` is that pair: three permitted changes arrive, seven forbidden ones do not, and a row that carries one of each is refused WHOLE, so the permitted half does not sneak in beside the forbidden one. A chip table applies a rake change exactly as it always did.

## What This Claims

Phase 7 checklist line seven is met for every configuration the arena can open today. It is deliberately not a claim about configurations that do not exist: bomb pots and the variants beyond NLH are not omitted cells, they are features the boundary still refuses. Both matrices are written as arrays for that reason - when a feature is admitted, its shape joins `FEATURES` and its stakes join the ladder, and the regression grows with the arena rather than being rewritten after it.

Nothing here opens a funded Diamond game.
