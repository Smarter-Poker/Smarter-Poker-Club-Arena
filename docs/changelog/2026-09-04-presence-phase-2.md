# 2026-09-04 - Presence phase 2: the nine gaps the disconnect audit left

Dan: "PROCEED TO THE NEXT PHASE." The phase is section 3 of
`docs/audits/2026-09-04-disconnect-protection-audit.md` - the ranked list of
what was still needed after the first pass. Items 8 (backgrounded-phone away
cap) and 9 (all-in disconnect protection) need Dan's ruling and are not here.
Everything else is.

## 1. The published clock is the armed clock

`ServerTableEngineHandEvents` stamped the ordinary 15s deadline before
`handleTurnChange` ran, and when `DisconnectEngine.onPlayerTurn` declined to
hand over the turn (MISSING seat: 30s countdown; sat-out seat: 350/1250ms
beat) the broadcast still carried the 15s. Every client drew a full ring for
a seat the engine would act for in under a second, or watched it hit zero
and then waited out the rest of a 30s clock. `armedAutoActionDeadlineMs()`
exposes the timer the engine actually holds and `handleTurnChange` re-stamps
`playerTurnStartTime/Duration` from it, synchronously, before the broadcast.
`ArmedDeadlineIsPublished.test.ts`.

## 2. Presence survives the hourly restart

`checkCrashRecovery` restores the FSM only from an incomplete hand snapshot,
and the :55 park guarantees there is none. `hand_state_snapshots` cannot carry
it (2.8M rows, 7.7 GB, no `table_id` index on completed rows; an incomplete
row reads as a hand in flight to the tournament balancer). New table
`engine_presence_parked` (one row per table, engine only; migration
`20260904230754`, applied via the MCP, declared in
`scripts/ci/schema-manifest.d/presence-phase-2.json`). `pauseForMaintenance`
writes it when the break is announced, the dealing loop writes it again when
it parks, and `start()` reads it back once while fresh (20 min) when there
was no crash snapshot. `PresenceSurvivesTheRestart.test.ts`.

## 3. The bar says WHY you sat out

`sitOut()` records `sitOutReason` ('voluntary' | 'forced'); it travels in the
presence map as `sitOutReason`; the hero's footer bar reads it and says "You
Timed Out Three Times, So You Are Sitting Out" for a forced one, with the
same I'm Back. `theBarSaysWhyYouSatOut.test.ts`.

## 4 + 10. The FSM entry carries what a restore needs; dispose() leaks nothing

`DisconnectFsmEntry` now carries `sitOutSinceMs`, `sitOutOrbits`,
`sitOutReason`, `strikes`, the two away-blind flags and `pageLeftAtMs`;
`getFsmState` projects them and `restoreFsmStates` reads them (all optional -
an older snapshot restores exactly as before). `sinceMs` for SAT_OUT is the
sit-out's own start, so a crash-recovered sit-out no longer restarts its
5-minute clock at the moment of the crash. `dispose(tableId)` now cancels
the transport-grace timers it used to leak.

## 5. A quiet table tracks its seats

`heartbeat()` and `notifyTransportDisconnect()` register a SEATED player on
demand (`registerSeatedPlayerOnDemand`, shared with `notifyPageLeft`), so a
seat taken since boot at a table below the deal minimum is tracked before
the first deal. A spectator's signals still register nothing.
`QuietTableTracksItsSeats.test.ts`.

## 6. The action row is marked while the socket is down

`ActionPanel` takes `connectionStale`; TablePage passes
`engineWsStatus !== 'connected'`. The row dims and says "Reconnecting To The
Table, These Buttons May Be A Moment Behind". Marked, not disabled: the HTTP
action path is a second transport and the server refuses an out-of-turn
action itself.

## 7. One connection vocabulary

The tab-bar chip (Supabase realtime feed) now says "Live Feed Reconnecting"
with a title naming what it covers, so it cannot be read as the table's own
socket. The top-of-page offline bar (`navigator.onLine`) stays off the
`/table` route - the felt banner owns that state there. The dead
`ConnectionIndicator` stub is deleted.

## 11 + 12. The player's own facts ride the engine socket

`TableStateHub.sendToUser` delivers a private `USER_EVENT` frame to every
open socket one user holds on a table (subscribers carry `userId` now);
outside the seq chain, never retained. The engine sends the hero's hole
cards this way at the deal (in the same row shape the Realtime handler
accepts, so `heroHoleCardsAreForThisHand` and the recovery re-arm apply
unchanged) and the engine's copy of the pre-action on every
PreActionEngine event (SET / EXECUTED / INVALIDATED / and a new CLEARED),
and re-sends both on RESYNC. `EngineStateClient` hands the frame to
`onUserEvent`; `useEngineTableState` exposes `lastUserEvent`; TablePage
routes hole cards into `handleHoleCardPayload` and reconciles the bar to the
engine's pre-action (same value: no-op; different: re-arms and converges;
engine has nothing: clears without a round trip). The Realtime row and the
poll stay as the belt. `TableStateHub.userEvent.test.ts`, pins in
`reconnectIsAnEvent.test.ts`.
