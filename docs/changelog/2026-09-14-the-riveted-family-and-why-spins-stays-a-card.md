# The riveted family, and why spins stays a card

2026-09-14. Branch `feat/riveted-spins-banner-families`. Follows #4504 (shark).

## The riveted family

Dan's spade NLH master (`game-cards/nlh/spade-nlh-premium-v1`, 729 wide) cut
into `console/riveted-console-v1/`: bolted corners, a header well with a chrome
capsule pill slot, and a base that steps OUT around two plates and carries the
spade chip medallion.

- `top.png` 729 x 209: master rows 37-245, through the well and its chrome
  outline to the glass gap before the first bay.
- `mid.png` 729 x 8: a median of rows 246-256, the only band in the whole
  master where the rail matches the head's own rail (mean difference under
  12/255) with glass between. Everywhere below, the rail carries LED nubs, bay
  borders or the base.
- `bottom.png` 729 x 333: rows 582-914, from the glass gap above the base to
  the LED under the chip.

The base is wider than the body. That is the master's silhouette, kept: the
frame widens where the plates sit, exactly as the lobby card does.

`SpadeConsole family="riveted"`. Two plates, like the spade, on a heavier
frame. The families now live in one `FAMILY` table in the component - width,
head height, foot height, zones, plate count - so a fourth is one row and one
stylesheet block. Body text is padded to line up with the title column.

## Spins stays a card

The spins master (`shark-spins-premium-v1`) was profiled the same way and
cannot be cut. Its rails change every few pixels - bolts, LED nubs, brackets,
the frame's own contour - and there is no glass gap anywhere between the head
and the plate: every seam candidate lands on a chrome divider. There is no
band in it that repeats. Stretching it would mean inventing rail art, and the
standard says to stop there. It stays a fixed card for the prize widget it was
painted for; VIP and promotion pages take the shark with gold ink.

## The banner already exists

The Kingfish master is already `ClubIdentityCard` on the club home page - a
fixed-ratio layered card with measured zones. Club pages reuse it as their
header. Nothing to cut.

## The families, as they stand

| family                      | master         | plates | for                                   |
| --------------------------- | -------------- | ------ | ------------------------------------- |
| spade                       | spade PLO      | two    | rules, announcements, settings, admin |
| shark                       | shark heads-up | one    | tournaments, lobby, one-action popups |
| riveted                     | spade NLH      | two    | money: cashier, wallets, settlement   |
| banner (`ClubIdentityCard`) | Kingfish       | none   | the header on club pages              |
| strip (wallet row)          | my-wallets     | none   | rows in lists                         |
| spins (fixed card)          | shark spins    | one    | the prize widget only                 |

## Verification

Rendered at 393px with the label fix live: every plate label on every family
sits inside its face (all seven measured negative). Copy gates and no-emoji
OK. Tests in the log.
