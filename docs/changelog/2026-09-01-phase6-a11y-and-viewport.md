# Phase 6 items 12 and 13 - an overlay does not claim what it is not

2026-09-01. Branch `phase6/a11y-and-viewport`. Stacked on the wheel-clock
lineage, since it touches `SpinWheel` again.

## Item 12 - two ARIA claims that were worse than silence

**The wheel was not a dialog.** It carried `role="dialog" aria-modal="true"`
with no focusable control, no focus move and no way to dismiss it. `aria-modal`
tells assistive tech to ignore **everything** outside the element, so a screen
reader announced "Spin Multiplier Draw, dialog" and then hid the rest of the
table for the whole hold - in exchange for an overlay the player cannot
interact with at all.

A focus trap is the right fix when there is something to focus. There is not:
the wheel is a decoration that resolves itself. So it stops claiming to be a
dialog. The meaning it genuinely carries is untouched - the `role="status"`
live region added on 2026-08-31 still announces the multiplier, the prize pool
and who cashes.

**The odds grid was not a table.** `role="table"` over plain divs with no
`role="row"` and no `role="cell"` anywhere beneath it, so a screen reader
announced a table and then found nothing in it. The layout is a visual grid and
the content reads correctly in DOM order, so it is now allowed to be what it
is rather than claiming a structure it does not have.

Still open from item 12, and named rather than quietly skipped: the buy-in
sheet has Escape but no focus trap. It has real focusable controls, so a trap
IS the right fix there - and a correct one needs the first-focus, the wrap and
the restore-on-close all working together, which is a piece of work rather than
an attribute.

## Item 13 - a short viewport clipped the reveal and hid the button

`SpinWheel.css` had **zero** height-based media queries while `.sw__tree` is
pinned at `top: -132px`. On a landscape phone - 375px of height is ordinary -
the starting tree rendered at roughly -10px and was clipped, so the 3-2-1 the
whole sequence is built around happened off screen.

Two steps rather than one continuous scale: at 560px the tree tucks back inside
the stage, and only at 440px does the disc shrink as well. The result card is
never scaled, because it is the part that carries the answer.

`.seat-buyin-confirm` was a fixed, centred flex box with no `overflow-y`. On
the same screen the card is taller than the viewport and the confirm button sat
below the fold with no way to reach it - the player could see the buy-in and
could not take it. The wrapper scrolls now, which costs nothing on a tall
screen and is the whole fix on a short one.

## Verification

- `npx tsc --noEmit`: clean.
- `tests/an-overlay-does-not-claim-what-it-is-not.law.test.ts`: 4 tests, green,
  registered in `docs/LAWS.md`. The ARIA pins strip comments first, so prose
  about `role="table"` cannot satisfy them.
- Not verifiable from here: how it looks at 375px of height, and how it reads
  in a screen reader. Both are argued from the markup and the geometry rather
  than from having used them.
