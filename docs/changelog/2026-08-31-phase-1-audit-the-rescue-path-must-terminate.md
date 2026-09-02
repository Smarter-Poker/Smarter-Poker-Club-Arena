# Phase 1 audit — the rescue path must terminate, and two other seat drops

2026-08-31, immediately after #2049 merged. A hostile re-read of my own phase 1
diff, plus a full-tree run. Three real defects, one of them mine and serious.

## 1. The rescue path could not stop (MY BUG, introduced in #2049)

The new "engine seats you, the client renders nothing" invariant healed like so:

    setTableState((prev) => {
      if (prev.players[seat - 1]?.id === userId) return prev;   // never true
      const players = [...prev.players];
      while (players.length < seat) players.push(null);
      return { ...prev, players, ... };                          // always new
    });

The heal grows the array with NULL rows. It cannot place the hero row — it has
a seat number, not a player — so the early-return guard could never become
true. Every pass produced a fresh `players` identity, the effect's deps
changed, and it ran again: **an infinite render loop, armed on precisely the
path that fires when a player is stranded.** The bug was in the rescue.

Fixed by shape, not by a smarter guard: extracted to a pure
`reconcileHeroSeatFromEngine()` (`src/lib/heroSeatReconcile.ts`) that returns
`null` when nothing needs changing, so idempotence is a property tests can pin
rather than a comment asking you to trust an inline reducer inside a 20,000-line
component. It also bounds growth at `MAX_SUPPORTED_SEATS`, so a corrupt
`seat: 1e9` off the wire cannot hang the tab.

`tests/unit/heroSeatReconcile.test.ts` pins it, and the pin was verified real:
reverting the function to the broken shape turns it red, restoring it turns it
green.

## 2. The same seat drop, in the path that paints FIRST

`applySeats` (the REST prefetch that renders the table in the 3-5s before the
websocket connects) skipped any seat outside the current array:
`if (idx >= 0 && idx < p.length)`. That window is exactly when `maxPlayers` is
still the default 6 — so a player in seat 7, 8 or 9 was missing from the first
paint of every table, hero included, until an engine snapshot happened to
overwrite it. Same defect as the mapper's, one layer earlier, and easy to miss
because the engine usually papers over it a moment later. It now grows to fit
what the server returned, and raises the ring with it.

## 3. main was already red, from #2054, and had been

`tests/unit/seatFirstBoardAndCounts.test.ts` and
`tests/unit/todaysIncidentsStayFixed.test.ts` both pin the guard that stops a
table-less game from covering its price point — the "44 of 50 Spins and
Heads-Ups could never be joined" incident. #2054 renamed `withTable` to
`withJoinableTable` and made it stricter (a CLOSED table stops counting too)
but did not move the pins, which house rule 8 requires in the same commit. Both
pins moved to the new mechanism. The law is unchanged and now enforced more
tightly; nothing was weakened.

## Verification

- Full client tree: **686 files, 9,860 tests, 0 failures** (was 2 failing on
  clean origin/main before this commit).
- `tsc --noEmit` clean. `npm run build` exit 0.
- Regression pin proven red-then-green against the pre-fix shape.
