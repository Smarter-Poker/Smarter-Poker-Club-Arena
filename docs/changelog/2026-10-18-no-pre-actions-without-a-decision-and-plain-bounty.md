# 2026-10-18 - No pre-action buttons without a decision; the bounty is just the number

## 1. Pre-action buttons only when a decision is coming

Dan, verbatim: "WHEN YOU MAKE A BET OR RAISE AND ARE NOT 'FACING ANY ACTION'
THE DEFAULT CHECK FOLD, CHECK, CALL ANY BUTTONS SHOULD NEVER APPEAR UNLESS
YOU ARE FACING A DECISION."

Seen live in a Diamond Arena tournament: the hero raised to 600 preflop and
the bar under the table offered Check/Fold, Check and Call Any while the
action went round. None of those could be used unless somebody raised.

Cause: the PreActionBar gate asked only "is it somebody else's turn and is the
hero still in the hand". It never asked whether the hero had a turn coming.

Fix (`src/lib/preActionPanelGate.ts` `heroAwaitsADecision`, wired in
`TablePage.tsx` as `heroFacesADecision`): once the hero has checked, called,
bet or raised on the current street and owes nothing, the bar stays down and
`data-hero-action` reads `none`. The moment a bet or raise lands over the hero
the call price is above zero and the bar returns with Fold / Call / Call Any.
A hero who has not acted yet this street keeps the bar (big blind option
included: posted blinds carry no action label). Any pre-action still armed
when the decision disappears is cleared, so a later bet cannot inherit an
invisible arm. The engine's own pre-action beat is untouched.

Pinned by `tests/unit/noPreActionsWithoutADecision.test.ts`.

## 2. The bounty shows the amount and nothing else

Dan, verbatim: "THE 'BOUNTY' SHOULD NOT BE ORANGE, AND SHOULD JUST DISPLAY
THE AMOUNT, IT SHOULDN'T HAVE A CHIP NEXT TO IT. JUST THE NUMBER."

`SeatSlot.tsx` drops the chip glyph from both the regular and mystery bounty;
`.seat__bounty` in `SeatSlot.css` loses the orange gradient pill, border,
glow and its animation and is now a plain white figure with a dark shadow for
legibility, in the same place above the seat. The 2026-08-25 pin "has
dimension rather than a flat fill" in `tests/unit/tourneyUxSweep20260825.test.tsx`
is replaced in the same commit by a pin for the new look.
