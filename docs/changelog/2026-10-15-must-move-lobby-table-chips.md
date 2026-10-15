# Must Move Lobby: Average Stack And Total Chips On Every Table Header

**Dan, 2026-10-15:** "When you open the lobby of a Must Move game it should have
the tables Average Stack Size and Total Chips On Table listed in the headers
after 6/6 players."

## What Changed

- `lobbyTableChips(table)` in `src/services/cashGameLobby.ts` returns the total
  of every occupied chair's stack and the average over those chairs. It sums in
  cents so a decimal stack never reads as a float artefact, skips open chairs,
  and reads an empty table as 0.00 / 0.00. Every seated player counts, horses
  included (CLAUDE.md 10.5).
- `MustMoveLobbyModal` prints two new header items directly after the
  `seated/max` count on every table: **Avg Stack** and **Total Chips**, both
  through the modal's own `formatAmount`, so a Diamonds game reads in Diamonds
  and a chips game in chips.
- `MustMoveLobbyModal.css` adds `.mml-table-stat` (label + value) in the header's
  existing type scale. The header already wraps, so at 375px the two stats drop
  to a second line instead of overflowing.

## Data

No schema or engine change. The lobby RPC already returns every chair's stack;
the header derives both numbers from those rows, so they always agree with the
stacks listed underneath.

## Tests

`tests/must-move-lobby.test.tsx` pins the values on all three fixture tables
(Main 1 141.00 / 23.50, Main 2 42.50 / 21.25, Feeder 65.00 / 32.50), that they
follow the seat count, and the helper's cent arithmetic and empty-table case.
