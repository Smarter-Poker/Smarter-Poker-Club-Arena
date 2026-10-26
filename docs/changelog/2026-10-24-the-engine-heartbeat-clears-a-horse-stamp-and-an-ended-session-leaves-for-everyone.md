# The engine heartbeat clears a horse's Lightning stamp, and an ended session leaves for everyone (2026-10-24)

Follows `2026-10-24-a-horse-whose-pool-session-ended-leaves-its-anchor-seat.md`
(PR #7973), and closes both items that file left open.

## A. The stamp a horse could never clear

### What was measured

"FLH 0.25/0.50 Lightning Games" (Cluster `5be919f7-...`), read-only on
production: the engine started dealing at 15:49:31 UTC after a restart. At
15:49:46.347 one `player_disconnected` batch (engine-clocked `p_now`) stamped
seven pool players, all horses. Room sockets reported three back at 15:49:46,
15:50:06 and 15:50:24. The other four were exited by
`fn_lightning_reap_expired_disconnects` at 15:52:50 `disconnect_expired`
while their anchor engine was heartbeating every one of them.

### Root cause

`fn_lightning_presence_report` clears `disconnected_at` only for a player in
`p_reconnected`, and the only caller that ever put anyone there was
`LightningRegistry.connect` (a room's first socket). A horse's input device is
its anchor engine's heartbeat (CLAUDE.md 10.5 item 2), never a room socket, so
once a horse was stamped nothing could clear it. The guards that keep a horse
from being stamped (`connectedAtAnchor` on a room close, "unknown is never
stamped" in the boot pass) both depend on the anchor engine already reporting,
which is exactly what is missing in the first seconds after a restart.

### The fix

The engine now says what a returning socket says, through the same door:

- `ServerTableEngineDealing.reportHorsesTheEngineHeartbeatKeepsHere` runs in
  the parked anchor pass (after the bust recovery, before the ended-session
  stand-up). Every 15 s it reads, for the horses whose heartbeat is live here
  (the presence FSM reads CONNECTED), which hold an OPEN pool session with a
  stamp (`lightningStampedPoolSessions`, a read), and reports each one.
- The report goes through `LightningEngineInputDevice` (a narrow port, wired at
  boot) to `LightningRegistry.engineInputDeviceLive`, which refuses a seat the
  horse account's own client controls (`isClientControlling`, the same check
  the hand host's `clientControls` uses) and otherwise calls the presence
  reporter's `reconnected`: the same batching, the same bounded retry and the
  same `fn_lightning_presence_report` a room socket uses.
- A person is never reported from the engine. A person is cleared only by their
  own socket. Nothing during the freeze, nothing on an unreadable pool.

No migration: the SQL door already clears exactly what it is told.

Law: `server/src/engine/aHorsesEngineHeartbeatClearsItsLightningDisconnectStamp.law.test.ts`.

## B. A person whose session ended kept the seat

PR #7973 stood up a HORSE whose pool session ended while it kept its anchor
seat. The rule carried `p.is_horse`, so a person in the same place kept the
seat and chips for as long as the Cluster stayed Lightning (the anchor does not
deal, the seat trigger needs a seat change, and the parked pass runs no sit-out
eviction). Dan approved (2026-10-24) the identical treatment for everyone.

The hook is now `standUpPlayersWhosePoolSessionEnded`, with the horse condition
removed rather than a second branch added. Every player leaves through the
ordinary Leave door (`leaveTable`: stay clock, voluntary cash-out into the club
wallet with its receipt, `seat_left`, Cluster wake), only when the same
occupancy reads ended on two looks at least 30 s apart, never on a failed read,
never during the freeze, never while in a live hand (checked before the read and
again at the door), and never for a seat sitting out or already leaving.

The law was renamed to say so:
`server/src/engine/aPlayerWhosePoolSessionEndedLeavesItsAnchorSeat.law.test.ts`
(it also pins that the override contains no horse condition).

### What the returning person sees

`fn_lightning_reconnect_state` answers the latest exited session, state
'ended' with its `exit_reason`, and NULL seat pointers once the seat is stood
up; the room's ended notice says how it ended ("Your Lightning Session Timed
Out.") with no seat line, and VIEW GAME goes to the Cluster's entry.
`fn_lightning_my_session` answers `{ pool_session_id: null }`, so the entry
shows the approved cash card with JOIN LIGHTNING. An open session with a NULL
anchor pointer is parsed to nulls and still opens its room. Pinned by
`tests/lightning/a-cashed-out-lightning-player-is-offered-join-lightning-again.test.ts`.
No client source changed.

Continuation qualification preserves main's tanking-clock helper and newer
idle-balance tests. The heartbeat log says a reconnect was reported, because
the original presence reporter queues the database transition asynchronously;
queue admission alone cannot certify that its disconnect stamp was cleared.
