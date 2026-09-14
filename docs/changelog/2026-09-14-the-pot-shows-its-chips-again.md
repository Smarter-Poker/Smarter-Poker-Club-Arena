# The pot shows its chips again

Dan, 2026-09-14: "BOMB POTS CHIPS DON'T UPDATE TO DISPLAY THE ACTUAL AMOUNT IN
THE POTS... IT SHOULD SHOW MULTIPLE CHIPS AS WELL." A 30 pot drew one red chip.
A 74 pot drew one white chip. A 144 pot drew one white chip.

Every disc was already there. `breakChips` had the right ladder, `PotChipPile`
put every chip of it in the DOM, and `tests/chips-on-the-felt.test.tsx` had been
green on all of it since 2026-08-23 - it asks the DOM what is painted, and the
DOM was never wrong. What was wrong was WHERE they were painted: #771 moved the
pile from a column to `display: grid` with `grid-area: 1 / 1` on the stack and
on every chip, which is the CSS for "all of you occupy this one cell". Ten discs
landed inside the 3px band left by an inline `translateX` jitter, and the player
saw the last one - the LOWEST denomination in the pot, alone. Nothing about it
was specific to a bomb pot: a bomb pot is simply the first pot of a hand that is
already large and already mixed, so it is the one where a single wrong-coloured
disc cannot be mistaken for the pot. A three-white-chip pot had been drawing one
disc too, and looked close enough to right to survive for three weeks.

The pile is a column again, and the discs are spaced by `--cp-chip-overlap`
(slice minus size, both derived from the one chip token), so each one below the
top leaves exactly `--cp-chip-slice` showing and the pot's tower is spaced
identically to the bet that swept into it. Highest denomination on the bottom,
out of DOM order, as Dan asked on 2026-08-24. A group clamped for height now
prints its true count beside the tower - the pot had the stylesheet for that
badge and rendered it nowhere, so a 60,000 pot showed ten orange chips and no
sign of the other two.

Measured headless at 393px against the shipped stylesheets: the tallest tower
the pot can draw is ten discs, 45.9px, which leaves 29px between the bottom of
the pile and the top of the board. The pill does not move.

The guard for this reads the stylesheet, because jsdom does not lay out CSS and
every DOM-level test here stayed green throughout the bug.
