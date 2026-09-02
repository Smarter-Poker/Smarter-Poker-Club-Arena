# 2026-08-28 — The wrong table can no longer paint on arrival at /table/\*

## Symptom (Dan)

Opening a table showed the previous or a different table for a split second.
The theme first-paint cache (same day, earlier changelog) removed one source;
this removes the remaining three.

## Root causes and fixes

1. MultiTablePage derives `hidden` SYNCHRONOUSLY from the URL, but synced
   `tables`/`activeIndex` in a PASSIVE effect. On the commit where the URL
   became /table/B the container un-hid and painted the previously active,
   fully populated table (real seats, pot, cards) for one frame. With [A, B]
   open and B focused, arriving at /table/A painted B first. The route sync is
   now a `useLayoutEffect`, which runs before the browser paints — tab sync
   and visibility land in the same frame. This also removes the "No Tables
   Open" empty-state flash when the first table of a session arrives by route.

2. Tab switches (tap and swipe) never updated the URL, so the address bar kept
   naming a table the player had left; the next arrival at that stale URL
   painted it, and browser Back yanked the active tab. Both switch paths now
   `navigate(/table/<id>, { replace: true })` for real tables (lobby tabs
   keep the current URL — they have no route of their own).

3. TablePage applied `location.state.initialTableState` with no identity
   check, so a mount WITHOUT its own navigation (TABLE_SEATED append,
   tournament auto-seat, lobby-tab conversion) inherited another table's
   name, game type, blinds and seat count — including the wrong seat ring,
   since maxPlayers seeds createEmptySeats. The payload's `tableId` is now
   compared against the mount's own; payloads without one (direct navigation
   only) are still accepted.

## Pinned by

`tests/unit/wrongTableNeverPaints.test.ts` — layout-effect contract, URL
agreement on both switch paths, the identity guard, and the producer stamping
`tableId` into the payload.
