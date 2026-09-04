# 2026-09-04 - A stack under 100 reads to the penny

Branch: `fix/stacks-under-100-to-the-penny`. Dan, with a screenshot of an NLH
0.02/0.05 table whose seats read "5", "9", "7", "3".

Dan, verbatim: "WHEN YOUR ACCOUNT BALANCE ON CASH GAME TABLES IS UNDER 100
CHIPS IT SHOULD DISPLAY IT AS 99.99 DOWN TO .01. IT NEEDS TO BE ACCURATE TO
THE PENNY WHEN USERS HAVE LESS THAN 100."

## Root cause

`SeatSlot.formatStack` squared off every stack from ONE chip up
(`amount >= 1 ? Math.round(amount) : amount`) before handing it to
`formatTableChips`. The rounding was added to hide engine sub-chip float
noise on big stacks; at micro stakes it hid the money itself - 5.37 read as
"5".

## Fix

`formatStackChips` in `src/utils/format.ts`: under 100, two places always
(`toFixed(2)` also squares off sub-cent float noise at the cent, never at
the chip); from 100 up, whole chips through `formatTableChips`, never
abbreviated. `SeatSlot.formatStack` delegates to it, so the seat badge, the
stack-delta float and the net-win line agree. Bets, pots and typed raises
keep `formatTableChips`' own contract; only the stack rule changed.

## Test

`tests/unit/chipsOnTheFeltAreNeverAbbreviated.test.ts` gains a
`formatStackChips` block (5.37, 5.00, 99.99, 0.01, float noise, sign, and the
100-and-up whole-chip cases) and pins that the seat uses it and no longer
rounds a stack itself.
