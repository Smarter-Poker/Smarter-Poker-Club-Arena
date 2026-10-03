# 2026-10-03 - Daily Challenge reroll reflows at narrow widths

## Finding

The live browser certification reported horizontal content overflow in the
reroll control at 320px when text was scaled to 200%. The card remained within
the viewport, but the no-wrap Diamond price group made the control's contents
wider than its frame.

## Fix

At widths up to 420px, the reroll control and its price group can wrap while
keeping the complete accessible and visible wording. The one-Diamond reroll
price and all transaction behavior are unchanged.

## Regression protection

The existing `tests/e2e/daily-challenges-accessibility-responsive.spec.ts`
asserts that every visible challenge button has no horizontal content overflow
at 320px and 200% text. This is the exact failing scenario and remains enabled.
