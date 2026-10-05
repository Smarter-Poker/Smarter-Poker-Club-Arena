# The tournament result card, finished

Dan, 2026-10-05: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE AND
MAKE SURE THEY ARE FULLY WIRED IN AND TESTED BEFORE CLAIMING SUCCESS." This
follows `2026-10-05-the-result-card-has-an-x.md` and closes its follow-up list.

## Fixed

- **No decimal points with nothing after them.** Every chip figure went
  through a private `formatMoney` that forced two places: "120.00",
  "5,470.00". The card now prints through `formatPrizeCentsAtUnit`, the
  estate's one prize rule in the cents domain: a whole amount prints whole
  ("120"), an amount with real cents keeps them to the penny ("1.90", per the
  2026-09-04 penny ruling, and never understated), Diamonds print whole as
  before. The tests that pinned the forced ".00" were updated in this commit.
- **The player number reads "ID: 7".** It printed bare, so a "1" sat directly
  under a "#1" finishing place and read as a second placing. "ID:" is the label
  every other surface uses (ClubProfileModal, the cashier).
- **One close control.** The word Close at the foot of the glass is retired
  with Dan's go-ahead; the console's X in the head is the card's only close,
  as on every other popup. Escape still closes it.
- **Satellite qualifiers.** A qualification has no place, so the card showed
  an empty painted pill slot, a lone "-" in the medal and "Qualified" twice.
  The pill now names the prize (Seat / Ticket / Cash), the band says "Seat
  Won", and the medal carries the cup in first-place metal.
- **Long event names.** The subtitle shrank to its floor and still clipped
  ("...TURBO HYPER EDITIO"). Names over 34 characters are cut at a word and
  marked with an ellipsis; the share text keeps the full name.

## Built

- **The reveal.** The medal lands (0.18s), the place strikes in (0.5s), the
  payout rises (0.75s) and counts up from zero (0.8s, 0.9s long), the rest
  follows (0.95s). The real figure is always in the DOM, held invisible while
  the count runs; the running number is printed by CSS from a data attribute,
  so it is never card text for a screen reader, a copy or a test. A whole
  result counts in whole chips. Reduced motion collapses everything to the
  final frame through the global rule, and the count is skipped.
- **Share sends a picture.** `rankingShareImage.ts` paints the result at
  1000x1420 from the same master art as the card (top-vip, mid, the flat
  foot), in the console's inks, with the card's own medal and trophy paths.
  It is painted when the card opens, because iOS only opens the share sheet
  inside the tap's activation. Share sends image + sentence when the sheet can
  carry files, the sentence alone when it cannot, and with no sheet at all
  saves the image through `downloadBlob` (the one file door: an anchor on the
  web, the system share sheet in the app) and copies the sentence, reporting
  "Image Saved" on the plate. Any failure to paint falls back to the text.

## Not done

- **The crown crest repaint.** The recipe (`spade-console-v1/source/README.md`)
  needs gpt-image-1. On 2026-10-05 neither the cloud workspace nor the Mac's
  sandbox could reach api.openai.com, and no key is configured. The crest is
  shared by the VIP page and the tournament lobby, so it is one repaint when
  that access exists.

Pinned by `tests/components/TournamentRankingCardPolish.test.tsx`, plus the
updated `TournamentRankingCardMysteryBounty.test.tsx` and
`tournamentRankingHost.test.tsx`. Rendered in the console harness at 393px for
1st, 3rd, 47th, a bounty and mystery win, a satellite seat, a Diamond Spin, a
winning hand and the share image.
