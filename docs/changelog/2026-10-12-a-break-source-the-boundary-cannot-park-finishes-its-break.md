# A Break Source The Boundary Cannot Park Finishes Its Break

Date: 2026-10-12

## What Happened

Satellite 61961519 (Sunday Funday Six-Card Closer Satellite, Midway Union) froze at 23:52 UTC on 2026-10-11 with 9 players alive and dealt nothing for more than three hours while its level clock kept advancing.

1. At 23:51:53 a bust left 9 players on 2 tables. The cohort satellite read its qualifier state as unresolved for that moment and held the qualifier boundary, which parks every table until the state is read again with every table parked.
2. At 23:51:55 the balancer opened break 444d8b63 to retire table c01b0657. It stopped that table's dealer, moved all four players to table 4af8f60c (every attempt recorded as winner at 23:52:12), and called fn_f06_close_break.
3. At 23:52:21 fn_f06_close_break was cancelled by a statement timeout. The break stayed begun and table c01b0657 stayed 'running' in the database with a stopped dealer. The retirement custody keeps the exact reservation so the same manager can replay the close, and only the balance stage replays it.
4. From then on every sweep (one every five seconds, read in the API log) reached the qualifier boundary, listed both 'running' tables, found c01b0657 with no running dealer, and answered 'pending'. 'pending' resets the sweep cursor to the elimination stage, so the balance stage never ran again and the close was never retried. The boundary waited for the break and the break waited for the boundary.

The game variant was not involved: the satellite is NLH (its target, Sunday Funday Six-Card Closer, is PLO6).

## The Fix

TournamentManagerEliminations.checkSatelliteQualifierCompletion: when a table the boundary must park has no running dealer and an unacknowledged table break names it as its source, the check answers 'continue' and asks for an urgent sweep, exactly as the 2026-09-28 F06_SOURCE_EXCLUDED branch does. The boundary stays held, so no hand is dealt, and the sweep goes on to the balance stage, which retries the close, acknowledges the break, and retires the table. The next pass parks the one table that is left, reads the state, and releases the boundary.

TournamentManager.tableBreakOwnsSource answers from the manager's durable break state, which holds only unacknowledged breaks. A stopped dealer with no open break keeps the old 'pending' answer.

## Pinned By

server/src/tournament/aBreakSourceTheBoundaryCannotParkFinishesItsBreak.law.test.ts

## Players

No chips, seats or prizes were lost. The 9 live stacks sum to 210,000, which is 21 entries of 10,000 starting chips. The 12 busted players busted in dealt hands before the freeze. No hand was in the air when the table parked.
