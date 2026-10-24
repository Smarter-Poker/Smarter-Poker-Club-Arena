# The Sort The Board chips drive the board

Found in the line-by-line review after #7914. The lobby has two sort controls: the filter sheet's **Sort The Board** chips (the page's Sort By, saved per tab in the view prefs) and the column headings inside `LobbyTable` (saved per tab locally). They never talked to each other.

- **NLH, PLO, LIMIT, SPINS, HEADS UP:** the board always has a heading sort. The defaults are Stakes or Buy-In Low To High. So a chip pressed in the sheet changed nothing on screen.
- **MTT and ALL:** a heading tapped once silently outranked the sheet from then on.

**Fix:** `src/components/lobby/lobbySortBridge.ts` translates both ways.

- `headingForOrder(tab, chip)`: the heading sort the board adopts, or `reset` (the tab's default order, saved heading cleared).
  - Stakes High / Low maps to Stakes on cash tabs and Buy-In on events.
  - Most Players maps to Players High To Low.
  - Starting Time and Recommended map to the default order.
  - On ALL, every chip clears a tapped heading, so the page's chosen order shows. #7914 already made that order outrank the featured pin.
- `orderForHeading(tab, key, dir)`: the chip a tapped heading means. It is lit and saved, so the two controls agree on the next visit. Headings with no chip (Status, Name, Seats) leave the sheet alone.

`ClubHomePage` hands each chip press to the board as a `requestedOrder` stamped with a sequence number. The same chip pressed twice still applies, and a tab change never re-applies an old press. The board reports headings through `onHeadingSort`.

Tests: `tests/unit/lobbySortSheetDrivesTheBoard.test.tsx` covers rendered cash-tab chips, chip-after-heading, an ALL chip clearing a saved heading, heading reporting, and both mapping directions. The three rendered cases fail without the fix. The applySort source pin in `lobbyStakesMenuAndStyleSubtitle.test.tsx` now also expects the report-back call.
