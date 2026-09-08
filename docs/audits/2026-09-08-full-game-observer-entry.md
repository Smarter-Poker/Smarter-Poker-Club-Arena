# Full Running Games Remain Open To Observers

## Reproduced In Production

At 2026-09-08 11:30 UTC, the running 20 Chip Deep Stack Spin NLH game
288421a3-07e1-49f5-b8d2-6f97f062d88a showed three occupied seats and a disabled
Game Full button in GameLobbyPanel. The lobby row offered Watch. Selecting the
row, the normal route through the details panel, removed the observer action.
No paid entry or seat was taken during reproduction.

The panel checked capacity before reaching its existing Watch branch. The same
ordering blocked full heads-up SNG tables. Capacity should prevent another
buy-in, not observation of an already-running game.

## Change And Boundaries

Full games whose authoritative tournament row is RUNNING proceed to the existing
Watch action and onSpinJoin observer flow. Full games that have not started
remain disabled; completed games remain closed; existing entrants retain Return
To Game/Table. No registration or payment handler is added.

The raw tournament status matters: tournamentStatus deliberately labels a filled
seat-first game Running before the engine starts it. Using that display label
alone accidentally changes the full-but-registering case. The rendered-component
tests caught that case, and the guard now uses the authoritative raw status.

Eight rendered-component cases cover Spin and heads-up Watch clicks, full
registering games, existing entrants, and completed games. The tests use the real
tournamentEntry adapter and GameLobbyPanel; only the detail service is mocked.
The existing seat-first audit tests are also required. Release follows the
normal branch, autopilot, and Hetzner frontend publisher path.
