# Must Move lobby observations and seat-change confirmation

Reopening a game or changing accounts could display the previous opening's
snapshot, including its seat-change controls. Lobby observations now belong
to a single account, game and opening. A temporary refresh error retains only
that opening's last observation, and an old action cannot clear a new action.

Automatic polling now waits for an outstanding read or player action. A slow
successful response can finish; an explicit refresh can still supersede it.
Only the read that owns the polling hold can release it.

Seat-change request and cancellation replies require a confirmed success.
Requests also require a request identity and a destination or positive queue
position. Invalid, refused or incomplete replies follow the existing failure
path instead of displaying a success message. The database still chooses the
destination and executes the move.

## Evidence and remaining checks

The pre-change run on September 14 captured 28 failing cases and 8 passing
controls in `cashSeatChangeReceipt.test.ts` and
`cashGameLobbyLifecycle.test.tsx`. Four additional lifecycle cases cover
explicit refresh ordering, Strict Mode replay and overlapping action finishes.
An independent source review found no additional concern in these changes.

The new implementation and expanded tests have **not been executed** under
the replacement protected pipeline. Its source-job admission is not yet
qualified. Fresh client tests, type checking, the complete applicable catalog,
build/runtime composition checks and live behavior remain required. Historical
passes for earlier commits do not validate these bytes. Push and publication
are paused by the owner; this change is not a release or Phase 2 readiness claim.
