# The pot shows its chips again, lying in it

Dan, 2026-09-14, in three messages:

- "BOMB POTS CHIPS DON'T UPDATE TO DISPLAY THE ACTUAL AMOUNT IN THE POTS... IT
  SHOULD SHOW MULTIPLE CHIPS AS WELL."
- "CHIPS SHOULD ALWAYS BE LAYING HORIZONTALLY UNDER THE POT, NEVER STACKED
  VERTICALLY."
- "AND SHOULDN'T ALWAYS APPEAR IN NUMBER ORDER HIGH TO LOW OR LOW TO HIGH...
  THEY SHOULD APPEAR 'IN A POT' MIXED TOGETHER."

A 30 pot drew one red chip. A 74 pot drew one white chip. A 144 pot drew one
white chip.

## What was wrong

Every disc was already there. `breakChips` had the right ladder, `PotChipPile`
put every chip of it in the DOM, and `tests/chips-on-the-felt.test.tsx` had been
green on all of it since 2026-08-23 - it asks the DOM what is painted, and the
DOM was never wrong. What was wrong was WHERE they were painted: #771 moved the
pile from a column to `display: grid` with `grid-area: 1 / 1` on the stack and
on every chip, which is the CSS for "all of you occupy this one cell". Ten discs
landed inside the 3px band left by an inline `translateX` jitter, and the player
saw the last one - the LOWEST denomination in the pot, alone.

Nothing about it was specific to a bomb pot. A bomb pot is simply the first pot
of a hand that is already large and already mixed, so it is the one where a
single wrong-coloured disc cannot be mistaken for the pot. A three-white-chip
pot had been drawing one disc too, and looked close enough to right to survive
for three weeks.

## What it does now

The pot's chips lie in a horizontal spread under the POT pill, each disc over
the one before it, and the denominations are MIXED rather than sorted - four
players' chips pushed into the middle, not a dealer's rack. The overlap is half
a chip, derived from `--cp-chip-size` (the one chip token), so the discs are the
same discs the seats bet with and the spacing follows the table's width.

The mix is settled, not random. Each disc's place is keyed on its denomination
and its ordinal within that denomination, so the third red 5 lands in the same
place whatever else is in the pot: a re-render cannot re-deal the felt, and a
pot that grows slots the new chips in among the ones already lying there instead
of shuffling all of them. `Math.random()` would have reshuffled the whole pot on
every render React does for an unrelated prop.

A denomination clamped for width prints its true count below the spread. The pot
had `.pot-display__pile-multi` in its stylesheet and rendered it nowhere, so a
60,000 pot (twelve orange 5,000s, because the ladder has nothing between 5,000
and 100,000) showed ten chips and no sign of the other two.

## Measured

Headless at 393px against the shipped stylesheets: ten discs spread 77.8px wide
inside a 287px felt band, one chip tall, leaving the pill where it was and 60.8px
of clear felt between the chips and the top of the board. The POT pill does not
move; `tests/e2e/pot-above-chips.spec.ts` pins that and renders the pill alone.

The guard for the layout reads the stylesheet, because jsdom does not lay out
CSS and every DOM-level test here stayed green throughout the bug. The guards
for the mix - that the drawn discs still sum to the pot, that they are not in
denomination order, and that the same pot deals the same pile twice - read the
DOM.
