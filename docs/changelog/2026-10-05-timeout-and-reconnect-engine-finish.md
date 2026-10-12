# 2026-10-05 Timeout and reconnect upgrade, engine finish

Follows `2026-10-04-timeout-and-reconnect-audit-engine.md`. Engine change:
activates in a :55 window. No migration, no new database deadline, so
`fn_thaw_platform` is unchanged.

## A sit-out stamp read after the thaw is credited once

`fn_thaw_platform` already moves `table_seats.sit_out_at` forward by the
frozen interval. `restoreSitOutsFromSeats` seeds `sitOutSince` from that row;
seeded after the break completed, the entry had no `presenceThawedAtMs`, the
marker defaulted to the freeze start, and the next sweep credited the break a
second time (up to ten minutes instead of five). `DisconnectEngine.sitOut`
now brings the entry's own stamps up to date before it takes a database stamp,
so the marker sits at that freeze's end and the database stamp, already in
post-thaw terms, is not moved again. Seeded during the break (unshifted), it
is credited once with the rest.

## An expired reconnect allowance still waits a beat

A disconnected seat whose protection ran out on an earlier turn armed its
countdown at a past deadline, and the auto-action landed on the scheduler's
next 100 ms tick on every later turn of the absence. It now never lands
sooner than `sitOutAutoActionDelayMs(canCheck)`, the 350/1250 ms beat a
sat-out seat and a horse act on. The protection deadline is unchanged.

## Every player's clocks are counted

Always-on, zero-seeded, next to the horse input-device series (unchanged):
`poker_turn_timeouts_total{kind,audience,format}` at the three expiry sites
that record a strike, `poker_forced_sit_outs_total{audience,format}`,
`poker_disconnect_seconds` (observed on the reconnect edge in
`DisconnectEngine.heartbeat`), `poker_disconnect_auto_actions_total
{action,reason}`. `audience` is the seat. Observation only.

## A tournament move carries presence

`fn_move_tournament_player` opens the new chair with `is_sitting_out=false`
and `sit_out_at=NULL` (read from production's function definition), and no
engine state crossed with the player: every balance or break gave an absent
player a fresh CONNECTED entry, a new reconnect allowance and a reset strike
ladder. The manager now snapshots the source entry while the source is parked
at its boundary and deposits it BEFORE the move RPC (`SeatMovePresence.ts`,
withdrawn on a refusal); the destination claims it in `adoptMovedPresence`,
ahead of any registration, and writes a carried sit-out back to the new
chair. The tournament time bank is still dealt per table.

## A PONG or RESYNC is proof of life

`EngineWebSocketServer` gains `onAlive(tableId, userId)`, fired on PONG (every
admitted subscription of a mux socket) and RESYNC, wired in `index.ts` to
`engine.heartbeat`. Presence only; `heartbeat` never refunds strikes.

## Not done: stamping `disconnectedAt` from the last heartbeat (N3)

`disconnectedAt` anchors three things: the reconnect allowance
(`RECONNECT_BASE_SECONDS`, owner policy), the abandoned-seat five minutes
(documented as measured from when the engine concluded the player was gone)
and now the disconnect-duration metric. Moving it to `lastHeartbeat` on the
stale-heartbeat path would spend the whole 30 s allowance before it was
granted. Design if wanted: keep `disconnectedAt` and the grant at detection,
add a `lastSeenAtMs` (the `lastHeartbeat` at detection) carried in the FSM
entry, and use it only for the metric and, if the owner rules so, the
abandoned-seat clock.

## Tests

- `server/src/maintenance/theBreakDoesNotBurnAbsenceClocks.test.ts` (3 cases)
- `server/src/engine/afkSitOutGuard.test.ts` (3 cases)
- `server/src/observability/everyPlayersClocksAreCounted.test.ts`
- `server/src/tournament/aTournamentMoveCarriesPresence.test.ts`
- `server/src/transport/aPongIsProofOfLife.test.ts`

Each fix's new cases failed against the unfixed source.

## Not verified

Not deployed; no production table touched. The tournament handoff is proven
against the manager and engine in isolation, not on a live event.
