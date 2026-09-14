# Sign up, on the spade frame

2026-09-14. Branch `feat/felt-buy-in`, seventh commit. Tenth surface of the
sweep: the tournament sign-up, the one prompt in the lobby that takes money.

`signUpDialog` was the 2026-08-25 card: a rounded panel with a close glyph,
boxed rows, two bevelled buttons, tilting in on the X axis. Dan's binding
note that day asked for the middle of the screen, depth, and a 3D look. It
wears the spade frame now, the kit's confirm sheet, which is where the depth
comes from; the overlay still centres it and the card still tilts in.

## What prints where

- Eyebrow Tournament, title Sign Up or Late Register (`signup-title-<id>`
  kept as the dialog's name), the pill the kind of entry: Chips, PKO,
  Mystery, or Ticket in gold.
- Tournament, Entry Fee (one line, the total and its split, as before),
  Bounty in gold, Start Time and Your Balance as rows on the glass, the
  balance green when it covers the entry and red when it does not. Every
  row is a flex row with a real gap, so "Entry Fee: 50" stays two words.
- The shortfall as red copy (`role="alert"`), the unregister note as muted
  copy, both gated as before.
- Cancel and Confirm on the two plates; Confirm keeps the `btn-confirm` hook
  the open-effect focuses, and is disabled when the balance is short.

## Re-rendered, not rewritten

The queue, the balance read from the club that pays, the short gate, the
Escape path, the focus trap that treats the card itself as outside, and the
hand-back of focus are untouched. The 2026-08-25 sweep's style assertions
hold on the new sheet: the overlay centres (`safe center`, which the test
now accepts by name), keeps a perspective for the tilt, sits above every
other overlay; the card rotates in on the X axis; the rows carry the
engraved inset highlight.

## Verification

Rendered at 393 by 852 in five states - a plain sign-up, a PKO with a
bounty, a short balance, a late registration, a ticket entry - beside the
old card, and the PKO at a 1000px viewport at the 560px cap. Both plate
labels sit inside their faces; the title fits its zone in both wordings.
Copy gates and no-emoji OK; the covering suites pass.
