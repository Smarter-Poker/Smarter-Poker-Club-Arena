# The tournament result card has an X, and the place is set as the result

Dan, 2026-10-05, with a screenshot of a 1st-place card: "THE TOURNAMENT RESULT
CARD HAS NO 'X' OFF ON IT TO CLOSE THIS OUT, AND IT LOOKS PRETTY GENERIC
OVERALL."

## The X: root cause

Every popup took SpadeConsole's painted X on 2026-09-23 (`onClose`, item B6).
`TournamentRankingCard` was written into `NO_X_BY_DESIGN` in
`tests/unit/everyPopupHasAnX.law.test.ts` instead, with the reason "carries its
own painted close control (.trc2\_\_close) outside the console". That control is
the word Close at the bottom of the glass, under the stats - exactly where the
ruling says a player must never have to go to close a popup. The exemption was
false, so the law passed a card that broke it.

Fix: the console is given `onClose={onDismiss}`, so the head prints the X in
the VIP head's measured close zone, and the exemption is deleted, so the law
now holds this card to the X like every other console under a dialog.
`tests/components/TournamentRankingCardHasAnX.test.tsx` pins the behaviour: the
X is in the head, labelled Close, and dismisses the card. The foot word stays,
because the X ruling adds the corner and never removes a learned control.

## The design

Rendered in the console harness at 393px for 1st, 3rd, 47th and a bounty win.

- The place band was a flat solid slab with "1ST" in it. It is now the finish
  named in lit blue between engraved rules (Champion, Runner Up, Third Place,
  Finished), then the place in the master's engraved silver at the largest
  size on the sheet, numeral full height and suffix raised. The band colour is
  still the finish's metal and still distinct per podium step; it is the light
  the numeral stands in, with a lit hairline beneath.
- The medal carries a struck inner rim and stands in a slow-turning starburst
  cast in its own glow token (the reference card's starburst). Off the podium
  the burst is under half strength. Reduced motion holds it still.
- Total Payout moved from the corner of the player row to directly under the
  place, at twice the size, with the prize + bounties split under it.
- The player row is centred under the payout; Duration and Hands are split by
  an engraved vertical rule.

Palette unchanged: cool metal only (`rankingCardPalette.test.ts`), no new
tokens, no drawn controls, no clipped-gradient text.
