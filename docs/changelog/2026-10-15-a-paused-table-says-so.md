# A paused table says so (2026-10-15)

## What happened

The 6:00 AM Freeroll (a38b88a9) sat RUNNING with 58 players for 35 hours while none of its 8 tables could be admitted. The engine answered every viewer of those tables `TABLE_NOT_FOUND`, the same answer it gives for a table that does not exist. After three of those answers the felt told a seated player "This Table Is No Longer Running". That was false: the field was still seated and the chips were still on the felt.

## Fix

- `GameServer.isTournamentTablePaused(tableId)` is true while any tournament manager is failing to admit that table.
- `EngineWebSocketServer` takes a `tablePaused` probe, wired in `index.ts`. A SUBSCRIBE for a paused table keeps the `TABLE_NOT_FOUND` code, so every client keeps polling and rejoins the moment the table deals. Its message becomes `tournament_table_paused`. A probe that throws reads as not paused.
- `EngineSocketMux` maps that message to its own close reason (`subscription refused: TOURNAMENT_TABLE_PAUSED`). `EngineStateClient` re-exports `isTournamentTablePausedClose`.
- `TablePage` says "This Table Is Paused. Your Seat And Stack Are Safe And The Floor Has Been Alerted" once per pause, before the closed-table verdict can count the 4404. The notice is released when the socket connects.

## The rule for an event that cannot resume

Taken together with what already exists:

- its blind clock does not advance on hands that were never dealt (`levelClockOutage.ts` and the `advanceBlindLevel` hold);
- the floor is paged after ten minutes and every thirty minutes after that, with the refusal named (`Tournament.table_admission_failing`, Phase 3);
- its players are told the table is paused;
- it is never cancelled or paid out automatically. Cancelling a running event moves real money and stays a floor decision through the existing cancellation path.

## Tests

- `server/src/aPausedTableSaysSo.law.test.ts`
- `server/src/transport/EngineWebSocketServer.mux.test.ts` (paused and throwing-probe cases)
- `tests/a-paused-table-says-so.test.ts`
