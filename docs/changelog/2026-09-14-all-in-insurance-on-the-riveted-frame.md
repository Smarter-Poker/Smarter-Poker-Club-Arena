# All-in insurance, on the riveted frame

2026-09-14. Branch `feat/felt-buy-in`, fourth commit. Seventh surface of the
felt sweep, and the one with a clock on it.

`InsuranceModal` - the all-in insurance and EV cashout sheet - was the
generic metallic chassis: a header with a shield glyph and a timer badge,
two tab buttons, bevelled readout boxes, a horizontal slider, two preset
buttons, a pinned action row. Chips change hands here in twenty-five
seconds, so it wears the money family: the riveted frame, beside the time
bank store and the cashier.

## What prints where

- Eyebrow All-In, title Insurance or EV Cashout, the clock as the pill: the
  bare seconds, green, red from five. The pill keeps `role="timer"`, its
  spoken label and the `insurance-modal__timer` class the layout test reads.
  "All-In Insurance" stays the dialog's accessible name, on a hidden
  heading, so the visible title fits the zone at its full size.
- Outs: 6 and Pot: 1,240 as the strip under the head; Preflop All-In in
  place of the outs count when there is no flop, as before.
- Insurance and EV Cashout as two lit words when a cashout handler exists,
  the live one in white; no handler, no word, as before.
- Board, the leader's row and every all-in opponent's row, and the outs
  against you, as rows on the glass with the real card images.
- The fee as the figure on the glass, Rate and Insured Pot under it in the
  `insurance-modal__readout-value` spans the money-math test reads; the fee
  slider standing beside them, max at the top, min at the bottom - up and
  down, as the buy-in's, because a horizontal drag over a table is the
  table-switch gesture.
- Break Even and Constant Profit as lit words, the chosen one in white,
  `aria-pressed`, their titles kept.
- What each outcome pays as a line under a lit label.
- The EV tab: the guaranteed payout as the figure, Pot Size, Your Equity,
  Cashout Fee and You Receive as rows, the note as copy.
- No and Insure on the two plates; Play It Out and Cash Out on the EV tab.

## The body scrolls, the plates do not

The clipped-buttons fix of 2026-08-28 (Dan's recording, hand #3158299) is
kept in its substance and changed in its mechanism. The decisions are the
painted plates in the console's foot, below the body and never inside it.
The body is the one part that scrolls: its height is capped to what the
viewport leaves after the head and the foot, so at 393 by 852 the clock and
both plates are on screen from the first frame in every state and the
content above them scrolls under the frame. The layout test now checks the
invariant by the buttons - No and Insure are inside the dialog and outside
the scroll body - rather than by an action-row class that no longer exists.

## The kit, while here

- The plate pads in `cqw`, not a percentage. `.sc-plate` is absolutely
  positioned, so its `padding: 0 4%` resolved against the foot and took 30px
  off every plate at 375px. The kit now pads `0 1cqw`; a label that already
  fit at its designed size does not change, and one that was shrunk grows
  toward it. The riveted well is 84% of the plate, short of its rivets,
  where 70% left Play It Out at 9px.
- The pill zone accepts attributes (`pillAttrs`): a timer's role and label,
  a class a test reads.
- Every ink printed on its own here resolves by contract: the sheet imports
  `SpadeConsole.css` itself, as `classNamesResolve` requires.

## Re-rendered, not rewritten

Everything above the render is untouched: the server-anchored countdown and
its once-a-second tick, the exact-rate money math and the Constant Profit
seed, the single-flight guard, the Escape path, the focus on the dialog, the
EV cashout quote taken verbatim from the server.

## Verification

Rendered at 393px in six states - insurance alone, with the EV tab offered,
on the EV tab, with one second left, preflop, three-way - beside the old
component, and again at 393 by 852 in four of them to see the plates on
screen without a scroll; and at a 1000px viewport at the 560px cap. Both
plate labels sit inside their faces in every state. Copy gates and no-emoji
OK; the covering suites pass.
