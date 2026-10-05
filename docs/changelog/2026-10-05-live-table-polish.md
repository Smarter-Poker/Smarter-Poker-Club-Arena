# Live-table polish (2026-10-05)

The last review of the ten live-table fixes found no defects in the table page
or the engine. It did find errors the "+" sheet was discarding, and some
upgrades worth making.

## "+" sheet and moves

- **A failed cash read no longer says "No Open Seats Right Now".** Supabase
  returns a failed read as `{ error }` rather than throwing, and the sheet read
  that as an empty club. It now throws, reports the error and takes the lobby
  exit, as a stalled read does.
- The club lookup, the active-table read and both failure exits on the
  seat-move path now report their errors.
- The tournament buy-in read throws a failed read. It used to return an empty
  answer silently, which left the tab pill on a bare "MTT".
- Every move path now uses `tabIsTournament`, the same test the tab bar uses.
  A tab moved before its first snapshot still gets its toast and its move
  stamp.
- Both move paths name an unknown table "A New Table".
- The `/tournaments` backstop opens the lobby tab on the tournament list.

## Tournament dock and toasts

- **Screen readers can now read the dock.** It is a group with a real toggle
  button, and the dock's figures are no longer hidden inside a button. Tapping
  anywhere on it still toggles it. The toggle and the LOBBY button get a
  visible focus ring.
- The collapse choice follows another browser tab.
- **"You've Been Moved To" is no longer skipped when the new table's
  connection is slow.** If the socket was still connecting at the move, the
  10-second window starts when it connects. That only applies within a minute
  of the move.

## Release script

- On a rerun, the seal no longer reuses a recovery window that was reserved
  for a routine cause, so the off-cycle break cannot come back that way.
