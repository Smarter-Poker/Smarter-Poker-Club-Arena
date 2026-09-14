# The cashout request, on the riveted frame

2026-09-14. Branch `feat/felt-buy-in`, sixth commit. Ninth surface of the
sweep, the first off the felt: the wallet's cashout sheet.

`CashoutRequestModal` was the generic bottom sheet: a drag handle, a
gradient balance card, a boxed amount field, four bevelled percentage
buttons, a boxed note, a gradient submit bar. Chips leave the club here, so
it wears the money family: the riveted frame, beside the table cashier.

## What prints where

- Eyebrow Chips Out, title Cashout (`cashout-modal-title` kept as the
  dialog's name), the asset as the pill.
- Available Balance as the figure on the glass, 1,250.75 Chips.
- Amount as silver numerals over an engraved rule, the rule lit blue on
  focus; the field is still labelled Amount, still a decimal input with the
  same bounds. 25%, 50%, 100% and Max as lit words with their figures, the
  chosen one in white; the note as a line under Note (Optional).
- The error as red copy on the glass (`role="alert"`), the success as green.
- Pending requests as rows: the amount, its age, a red Cancel word, and the
  five-stop step tracker under it with its labels on two lines where they
  need them, where they used to run into one another. The section is placed
  after the form in the DOM and shown above it by CSS order, so the first
  thing the sheet focuses is the amount, never a pending request's Cancel.
- Close and Request Cashout on the two plates. Close, like the scrim, waits
  while chips are in flight (`closeIfIdle`); the confirm reads
  Submitting... while the request is out.

## The riveted plates learn to wrap

Request Cashout on one line fit the riveted plate at 60%, 9.5px on a phone.
The riveted family now opts into the two-line plate label the four-bay deck
introduced (`plateWrapBelow: 0.72`): its plates are 98 of 333 tall, so two
lines at the wrapped size sit comfortably on the face. A label that fits at
72% or better stays on one line; nothing on the cashier or the time bank
store changes.

## Re-rendered, not rewritten

Everything above the render is untouched: the held op id and the reasons it
is held, the synchronous submit and cancel locks, the settlement freeze
check, the focus trap and Escape, the realtime refresh, the two-second
auto-close.

## Verification

Rendered at 393 by 852 in four states - empty, with a pending request, a
frozen settlement error, and just after a successful request - beside the
old sheet, and at a 1000px viewport at the 560px cap. Both plate labels sit
inside their faces; the amount rule lights on focus. Copy gates and no-emoji
OK; the covering suites pass, including the escrow-flow source law.
