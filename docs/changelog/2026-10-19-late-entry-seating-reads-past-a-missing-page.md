# 2026-10-19: late-entry seating reads past a page of already-seated answers

`seatAcceptedEntrantsAwaitingChairs` (engine, `TournamentManagerBase`) seats
accepted entries of a running unlimited MTT that hold no chair. It read the
first 20 matching rows, asked `fn_seat_late_registrant` for each, and read
again. An entry the door answers `already_seated_or_missing` can still match
the read (registered, no table). If a whole page answered that way, the next
read returned the same page, every id was already attempted, and the method
reported "nothing left" while later entrants were still waiting for a chair.

Each page now leaves out the entries that answered `already_seated_or_missing`
(`.not('user_id', 'in', ...)`), so the read reaches the entrants behind them.
Everything else is unchanged. `LaunchRosterHandoff.test.ts` covers a full page
of such answers followed by three seatable entrants.
