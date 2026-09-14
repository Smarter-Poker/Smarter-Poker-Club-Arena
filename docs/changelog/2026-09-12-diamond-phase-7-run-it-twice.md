# Diamond Phase 7: A Diamond Table May Run It Twice

Status: Phase 7 In Progress. Checklist Line Three Is NOT Claimed. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## Why It Was Closed

Not policy. Arithmetic.

The run-it-twice runout cut every pot into integer **cents**, which is the indivisible unit of a chip and **half** of a Diamond. A five Diamond pot over two runs paid two and a half Diamonds a board. A fractional Diamond is refused by the hand guard, by the accepted-hand guard and by the SQL settler alike, so a Diamond table with run it twice on would have dealt a hand it could never settle: the table parks, every retry is identical, and the seat is stuck.

That is why `HandController` refused `ritEnabled` for a Diamond hand, and it was the right refusal for as long as the division below it was wrong.

## What Changed

A pot meets two divisions on this path, and both now happen in the table's own unit.

- The up-front per-board slice reads `unitCents` from the table: one cent for chips, one hundred for a Diamond. The stated rule is unchanged and so is the chip arithmetic, because `unitCents` is 1 there and `units === cents` by construction. Only what the rule counts in changes.
- `determineWinners` is told the same unit, so a tie chopped on one board is chopped in whole Diamonds. It already took a `chipUnit` argument for tournament chips; the runout simply never passed one.
- The whole-unit backstop and the display rounding, both of which existed for tournaments, now cover a Diamond for the same reason: the stack it lands in is an integer everywhere it is stored.

The odd unit goes where it always went: to the earliest board, and inside a chop to the first seat clockwise of the button.

`run_it_twice` and `allow_run_it_twice` still have to be **stated**. The engine reads an absent one as `true`, so leaving one unset would make the chip schedule's default this arena's answer, and this arena inherits nothing. What changed is that the answer may now be either boolean rather than only `false`. `run_it_twice_enabled` reads as `false` when absent and only ever turns the feature on, so it left the refusal list entirely.

`fn_poker_diamond_set_table_run_it_twice` is the staff door, the sibling of the straddle one. It writes all three columns rather than the one it was asked about, because the engine's answer is a composite of them, and writing the pair while clearing the third makes that composite exactly the answer the caller gave.

## Evidence

- `server/src/engine/RunItTwice.diamonds.test.ts`: the REAL `dealAndResolveRIT` against a REAL `HandController` on a Diamond table, for pots chosen so that neither division comes out even. Two and three runs, heads-up and three-handed, an odd pot and a 101-Diamond pot: every Diamond is conserved, every stack is a safe integer, rake and the jackpot fee are zero, and every recorded winner's amount is a whole Diamond summing to the pot.
- The same file pins the partition rule in isolation, including the small-pot case where one Diamond over three runs is 1/0/0 rather than nobody being paid.
- `server/src/engine/DiamondCashBoundary.test.ts` and `DiamondCashHand.test.ts`: a table that runs it twice is admitted, a column that never said is still refused, and a Diamond hand can now be constructed with `ritEnabled`.
- `tests/sql/run-diamond-run-it-twice.py`: in the isolated fixture, a table that runs it twice admits and funds a seat under either column form; an unset run-it column, an unset allow-run-it column, insurance, a bomb pot, the seven-deuce side bet, an unset rake cap and an unset jackpot percentage are each still refused at the door; and the staff door asks for a caller first and staff second.
- The whole server suite: 10,089 tests, none failing, including the nine existing run-it-twice suites that prove the chip path is untouched.

## Still Unavailable

Bomb pots and their board counts. A bomb pot's award rides the `p_units` lane, which `fn_ca_commit_hand_settlement` refuses for a Diamond hand, so it needs a Diamond obligation lane rather than a rounding rule. Checklist line three stays open until it lands.
