# 2026-10-23 More Winning Horses Play PLO

Dan, 14:57 CDT: "ALLOW MORE HORSES INTO THE GAME, BUT ONLY THE WINNING ONES."

The PLO list (only horses on it sit at PLO above 0.25/0.50) read 30 days and
needed 5,000 PLO hands at 1 bb/100, which left 8 to 11 horses for 36 PLO
tables. The same 1 bb/100 bar over the full 90-day record with 2,000 PLO hands
admits 31 proven PLO winners, and the cash roster is now Dan's 50-horse
ceiling instead of the floor-sized 43.

- `ca-horse-roster-refresh` (every six hours) now calls
  `fn_ca_horse_roster_refresh(50, 5000, 2000, 1.0, 90)`; migration
  `20261023205714` records it.
- The 31 PLO winners play the cash lane with a 16 hour cap, and 91 of their
  pending tournament bookings were refunded through
  `fn_ca_unregister_tournament_player_exact` so they can take PLO seats now.
