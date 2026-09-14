# The table cashier, on the riveted frame

2026-09-14. Branch `feat/felt-cashier`. Third surface of the felt sweep, and
the one ten places open.

`CashierModal` - the felt's top-up sheet - was the generic metallic chassis: a
bevelled input well, four bevelled quick buttons, a rounded confirm bar. Chips
move from the account to the felt here, so it wears the money frame: the
riveted family.

## What prints where

- Eyebrow Add Chips, title Cashier (the `table-cashier-title` id kept), the
  asset as the pill - Chips, or Diamonds on a Diamond seat.
- At Table and Account as rows on the glass. An unknown balance prints
  Unavailable in red, as before, and nothing can be added until it is known.
- The amount is the one drawn control, because the art paints no field: big
  silver numerals on the glass over an engraved rule, the currency in lit blue
  before them, no box. Focus lights the rule blue instead of drawing a ring.
  `aria-label="Amount To Add"` and `aria-invalid` as before.
- 25% / 50% / 75% / MAX are lit words, the chosen one in white; `aria-pressed`
  and the stagger as before.
- New Stack in green: chips in.
- Close (`aria-label="Close Cashier"`, disabled while busy) and Add on the two
  plates. Add reads `Add 938.06` - the accessible name the test clicks - or
  Processing... while the request is in flight, and is disabled until the
  amount is valid.
- Recent prints the last five as rows, adds in green, withdrawals in red.

## Re-rendered, not rewritten

Everything above the render is untouched: the per-attempt idempotency id and
its rotation rules, the `busyRef` double-tap guard, the focus trap with Escape
and Tab wrapping, the previous-focus restore, the reset on open, exact-
precision `formatAmount`, `clampToCents` and the whole-unit floor, the failure
banner that makes no claim it cannot back. The scrim still closes unless busy.

One deliberate change: the first focusable element used to be the close glyph,
so opening the cashier focused Close. The glyph is gone and the amount field
is first, so opening the cashier now focuses the amount.

## Verification

Rendered at 393px in four states - chips with nothing entered, 50% tapped, a
Diamond seat, balance unknown - beside the old component in the same states,
then the final render with 75% tapped and the field focused. Both plate
labels sit inside their faces in every state. Copy gates and no-emoji OK; 103
tests across the diamond-seat cashier suite (which types a fraction, checks
the floor, and clicks Add 99), class resolution, popups, hover, unread errors
and the animation law.
