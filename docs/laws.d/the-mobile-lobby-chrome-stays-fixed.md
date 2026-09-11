# tests/the-mobile-lobby-chrome-stays-fixed.law.test.ts

The three things Dan photographed on a phone on 2026-09-09, pinned where they
broke. The MY WALLETS plate printed "LOADING BALANC": a placeholder string
wider than a zone 26.5% of the plate, which an `overflow: hidden` grid cell
snaps to its start edge and clips (a count that fits was always centred). The
filter row scrolled up behind the FIND YOUR GAME deck and off
the page, because the deck is sticky and the row was not. The footer floated
above the bottom edge with the lobby travelling through the strip below it,
because `padding-bottom: env(safe-area-inset-bottom)` reserved the
home-indicator inset INSIDE a box that is deliberately transparent, and a
desktop browser reports that inset as 0. Each is the kind of change a later
edit undoes silently, so this asserts the count line is centred on the painted
title at 54.65% with room for any real count and never says Loading, that the count is
published from a layout effect BEFORE the loading skeleton returns (it comes
from the viewer's role, not from their money, so a dropped connection cannot
strand it), that the page never resets that count itself (2026-09-10: its
club-change effect zeroed the state in the same commit the wallet published
it, a child's effects run before its parent's, so the plate was wiped on every
load from the day the count shipped - which is what the photographed
placeholder, and then an empty bay, actually were), that the sort row is
sticky at the deck's measured height, and that
the footer strip is CLOSED rather than covered - a black skirt was written
first and thrown away, because `footer-clearance.test.ts` forbids an opaque
backdrop there under Dan's 2026-09-04 clipping rule.
