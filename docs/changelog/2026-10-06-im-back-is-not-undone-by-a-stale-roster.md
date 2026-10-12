# "I'm Back" is not undone by a stale roster (2026-10-06)

## What was wrong

Sitting back in clears the sit-out in the engine's memory at once and writes
`table_seats.is_sitting_out = false` without waiting for the write.
`restoreSitOutsFromSeats` runs on every pass of both the wait loop and the
dealing loop, and a roster read already in flight still says `true`, with the
ORIGINAL `sit_out_at`. The restore saw "the row says sitting out, memory says
not" and sat the player out again, on the old clock. A human who tapped Sit
Back In at 4:50 of the five minutes was told they were back, and could be
evicted and cashed out ten seconds later. The file's own note on
`restoreEntryHoldsFromSeats` names this race as the reason that restore runs
once only.

## The fix, at the cause

The engine records when it took each player back (`returnedFromSitOutAtMs`). A sit-out
row whose stamp is not later than that moment describes the sit-out that just
ended, and is skipped, on every pass for as long as that row keeps arriving. A
row stamped after the return is a new sit-out the database knows about and is
restored exactly as before, as is any player this engine never took back (the
restart case the restore exists for). The mark is dropped when the engine
itself sits the player out.

## Proof

`server/src/engine/ImBackIsNotUndoneByAStaleRoster.test.ts`.
