# The lobby filters step aside while you read

**Date:** 2026-10-11
**Branch:** `fix/filters-scroll`
**Reported by:** Dan: "GAME Filters INSIDE OF THE CLUB need to work like the
footer but in reverse. When they hit the top of the page when scrolling down
they should 'disappear' but when you scroll back up, they should re appear."

## What was wrong

Inside a club on a phone, the Find Your Game deck (the game type tabs, Filters
and the status chips) and the sort row under it are both sticky under the
global header. Stuck together they covered about 420px of an 852px screen, and
the game cards scrolled underneath them.

## What it does now

`useHideLobbyFiltersOnScroll` (new, `src/components/lobby/`) reuses the
footer's own `useHideFooterOnScroll` for the direction decision, so the
listener, the 24px travel threshold, "always present at the top" and "comes
back at the bottom" all match the footer exactly. It adds three gates:

- **Pinned.** The deck and the sort row leave only once both have reached
  their stuck places under the header. Until then they scroll with the page.
- **In use.** An open Stakes or Variant menu, an open control on the deck, a
  finger down on either, or the Filters sheet (`holdFilters`) keeps them in
  place.
- **Focus.** Keyboard focus reaching either one brings them back.

The motion is `transform` only (`ClubLobbyCommandTop.css`, FILTERS STEP ASIDE).
The deck rises by its own height and the sort row by its own height plus the
deck's, so both park behind the global header. A sticky element keeps its slot
in the flow, so no card moves. There is no transition, the same as the footer
("real time instant change"), so reduced motion has nothing to collapse.

On desktop the game table scrolls inside its cabinet and the deck never pins,
so nothing changes there.

## Enforcement

`tests/unit/lobbyFiltersHideOnScroll.test.tsx` checks that the filters stay
put until they are pinned, leave while you travel down, come back on the way
up (with the footer's threshold), stay while the sheet or a menu is open,
come back on focus, and that the CSS is transform-only.
