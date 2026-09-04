# Disconnect protection and reconnection: full audit (2026-09-04)

Dan: "We need to fully audit and enhance the disconnection protection / and
reconnecting functionality. Do a deep dive on what's currently in place, what
is still needed, and any and all ways this can and should be improved."

Two agents read every line of the client and engine paths; this is the
consolidated result. Section 1 is what exists, section 2 is what shipped
today in `fix/table-ux-aliases-connection`, section 3 is what is still
needed, ranked, with file references so the next agent starts from the code
and not from this summary.

---

## 1. What is in place

### 1.1 Transport (client)

- **One physical socket per browser** to `wss://engine.smarter.poker/ws/multi`
  (`src/services/EngineSocketMux.ts`), pre-warmed at boot
  (`ServiceBootstrap.ts`), one WebSocket-shaped facade per table.
  `EngineStateClient` (`src/services/EngineStateClient.ts`) owns
  reconnection: exponential backoff 1s -> 30s with jitter, never stops;
  status `failed` is announced at retry 10 (~3 min) but retries continue.
- **Liveness both ways**: server PING every 25s, closes a socket silent for
  60s (`server/src/transport/EngineWebSocketServer.ts` heartbeatSweep). Client
  staleness watchdog: soft RESYNC at 35s of silence, hard reconnect at 60s or
  three unanswered RESYNCs; a 15s handshake timeout; an `online` event
  fast-path that skips the backoff.
- **Close-code routing**: 4401 auth -> refresh token and retry; 4404 table
  not found -> slow ladder, status `idle` (engine restart window); 4429 rate
  limited -> slow ladder; 4901 superseded -> stand down.
- **A second transport**: HTTP `POST /heartbeat` every 5s from every mounted
  table (`TablePage.tsx` ~3179), carrying `turnRendered` so the engine can
  tell a client that painted the turn from one that did not.
- **Lobby warm-up** (`src/services/tableWarmup.ts`, 2026-09-03): roster read
  - SUBSCRIBE the moment a game card opens, so the felt paints with players
    on the first frame.

### 1.2 Presence FSM (engine)

`server/src/engine/DisconnectEngine.ts`, per seat:

| state        | meaning                                   | how you get there                                                               |
| ------------ | ----------------------------------------- | ------------------------------------------------------------------------------- |
| CONNECTED    | heartbeat or socket within the window     | any heartbeat                                                                   |
| MISSING      | transport gone, auto-action clock running | WS close held 8s (`TRANSPORT_GRACE_MS`) with no heartbeat, or a stale heartbeat |
| DISCONNECTED | the 30s clock ran out                     | `disconnectTimeoutSeconds`                                                      |
| SAT_OUT      | sitting out, voluntary or forced          | `POST /sitout`, or 3 consecutive timeouts                                       |

Emitted to clients as `disconnect_states {state, sinceMs, graceDeadlineMs}`
in every snapshot, plus per-seat `is_disconnected` / `is_sitting_out`.

### 1.3 What happens to the hand

- The turn clock **never pauses** for a disconnect (deliberate: a pulled
  cable must not buy time).
- Disconnected before the turn: no action clock is armed; a 30s
  `disconnect:<uid>` deadline auto-checks or folds. Disconnected mid-turn:
  the running 15s clock resolves them; an armed-but-unused time bank is
  disarmed so nobody is charged a bank they cannot use.
- Three timeouts -> forced sit-out. Sat-out seats auto-check/fold on a
  350/1250ms beat.
- **There is no all-in "disconnect protection"**; a disconnected player is
  folded, not protected. Whether that is wanted is Dan's call (section 3.9).

### 1.4 Reconnect (engine)

`DisconnectEngine.heartbeat()` on the edge back to connected: cancels the
transport window and the auto-action clock, zeroes strikes, refunds the
away-blind budget, clears `pageLeftAt`, emits `PLAYER_RECONNECTED`. The
engine then re-arms the turn timer if it is this player's turn (preserving a
used time bank) and re-pushes hole cards (`rePushHoleCards`, also on RESYNC).
A +5s reconnect grace is added to the action clock.

It does **not** un-sit-out: a forced sit-out needs "I'm Back".

### 1.5 Seat eviction

`evictExpiredSitOuts` (`ServerTableEngineBase.ts` ~3829), cash only, from
both the start-up wait loop and the dealing loop: sit-out past 2 orbits / 5
minutes, away-blind cap (1 SB + 1 BB charged while away), nit-game VPIP, and
since today an abandoned seat (section 2). Never evicts an all-in seat in a
live hand. `POST /away` (tab close / pagehide) marks the player away
immediately, keeps the seat, arms the blind cap.

### 1.6 Engine restart (hourly :55)

Every table parks between hands; seats, stacks, button, hand number, sit-out
flags and entry holds survive via the database. The in-memory FSM map does
**not** survive the scheduled path (section 3.4).

### 1.7 Connection UI, and where it is

| surface                                                                                                     | where                                                         | driven by                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| TableConnectionBanner ("Connecting / Reconnecting To The Table", "Connection Lost. Trying To Get You Back") | on the felt, wordmark line                                    | engine socket status, 1.2s grace                |
| DisconnectToast (the hero's seat presence)                                                                  | **on the felt since today**; was fixed at the top of the page | engine `disconnect_states`                      |
| seat DISCONNECTED overlay / SITTING OUT badge                                                               | on the felt, per seat                                         | snapshot                                        |
| MaintenanceBreakScreen                                                                                      | full screen, active tab only                                  | engine break row                                |
| TableTabBar "Reconnecting..." chip                                                                          | top of page                                                   | Supabase realtime watchdog, NOT the game socket |
| App.tsx offline bar                                                                                         | top of page                                                   | `navigator.onLine`                              |
| 15s "Still reconnecting" toast                                                                              | bottom-right toast                                            | engine socket                                   |

---

## 2. What changed today

1. **The mux socket answers its own PINGs** (`EngineSocketMux.ts`). Proven in
   Dan's browser against production: a facade-less `/ws/multi` socket was
   closed by the engine at 60-77s (`1001 heartbeat timeout`), which is what
   killed a table ~20s after it loaded whenever the player had been in the
   lobby 35-60s. Linger 60s -> 10 minutes now that a warm socket can live.
2. **Reconnect is an event** (`TablePage.tsx`, "RECONNECT IS AN EVENT"): the
   socket's edge back to connected resets GameServerAPI's circuit breaker
   (which used to refuse our own heartbeats for 30s after the network came
   back), sends one heartbeat immediately (the engine's un-away and
   auto-action cancel), and re-arms the hole-card read for a seated hero in a
   live hand with no cards on screen.
3. **DisconnectToast moved onto the felt**, gated on `isActive` and the
   socket, with honest copy: "Reconnecting Your Seat, Ns Until Auto Action" /
   "Reconnecting Your Seat, Your Chips Are Safe On The Server". "Session Lost.
   Refresh To Rejoin The Table." is gone; it was never true.
4. **The dead RESYNC on reconnect** in `EngineStateClient.onopen` (seq zeroed
   one line before the `seq > 0` test) now fires.
5. **Engine auth on every call**: `getAuthHeaders` uses the token cache ->
   getSession -> refreshSession before ever sending unauthenticated;
   `engineFetch` retries once on 401 with a refreshed token. This is the
   "Authentication Required" on I'm Back after a reload.
6. **Abandoned seats are released** (`collectAbandonedSeatEvictions`): a seat
   whose player has been DISCONNECTED or page-left for 5 minutes, at a table
   too quiet for blinds or turns, is cashed out with reason `abandoned_seat`
   and the player is told why on their next visit.
7. **`/away` registers the seat on demand** (`notifyPageLeft`): a beacon for a
   seat taken since boot at a table that had not dealt was answered
   `tracked: true` and tracked nothing.
8. **One I'm Back**: the floating bottom-right button (which also bypassed
   the in-flight guard) and the sit-out pill's button are gone; the footer
   bar's is the one.
9. Leave Table always leaves the view (see the changelog).

---

## 3. What is still needed, ranked

1. **Publish the real deadline for a disconnected or sat-out seat.**
   `ServerTableEngineHandEvents.ts` ~462 stamps `playerTurnStartTime/Duration`
   before `handleTurnChange` declines to arm a clock for a MISSING seat, so
   every client draws a 15s ring while the engine acts at 30s (disconnect) or
   ~1s (sit-out beat). The table visibly hangs 15s past a dead countdown. Fix:
   put `graceDeadlineMs` / the beat deadline in `turn_deadline_ms` for those
   seats, or suppress the ring.
2. **Persist the FSM across the hourly restart.** `restoreFsmStates` runs
   only from `checkCrashRecovery`, which returns early when there is no
   in-flight hand, and the maintenance break guarantees there is none. So
   every :55 every seat is treated as CONNECTED with strikes and the
   away-blind budget reset. Persist the map on the park path and read it at
   boot regardless of hand snapshots.
3. **Tell the player WHY they were sat out.** `PLAYER_SAT_OUT` carries
   `reason: 'forced'` and the strike count; the engine handler writes
   `table_seats.is_sitting_out` and emits no hub event, so the client cannot
   distinguish a forced sit-out from a voluntary one (`mapEngineSnapshot.ts`
   ~283 collapses both) and shows "You Are Sitting Out" to someone who never
   chose it. Emit the event; render "You Timed Out Three Times And Were Sat
   Out" with the same I'm Back.
4. **Crash recovery resets the 5-minute sit-out clock.** `getFsmState` puts
   `lastHeartbeat` in `sinceMs` for SAT_OUT; `restoreFsmStates` seeds
   `sitOutSince` from it; `restoreSitOutsFromSeats` then `continue`s for a
   seat already marked out, so the `Math.min` pull-back to `sit_out_at` is
   unreachable on that path. Store a real `sitOutSince` in the entry.
5. **`heartbeat()` / `markTransportGone()` have the same registration gap
   `/away` had** (`DisconnectEngine.ts` ~307, ~357): a seat taken since boot
   at a quiet table is untracked until the first deal, and `/heartbeat`
   answers `connected: true` for an unknown key. Register on demand for a
   seated player, as `sitOut()` and now `notifyPageLeft()` do.
6. **The action panel is not connection-aware.** With the socket down, the
   last snapshot's buttons stay tappable against `POST /action`. Disable or
   mark them while `engineWsStatus !== 'connected'` (the felt banner already
   says why).
7. **Two transports, one vocabulary.** The TableTabBar chip says
   "Reconnecting..." for Supabase realtime, driven by a watchdog whose health
   check `supabaseConnectionWatchdog.ts` ~101 documents as never having
   passed; the felt banner says "Reconnecting To The Table" for the game
   socket. A player can read two contradictory statements. Retire the chip or
   drive it from the game socket.
8. **Backgrounded mobile is treated as gone instantly.** iOS fires `pagehide`
   when it freezes a PWA; `/away` skips the 8s grace by design; the 5s
   heartbeat is frozen with the app. Two such windows spend the blind cap.
   Consider requiring a missed heartbeat OR a WS close before `pageLeftAt`
   alone arms the cap.
9. **Disconnect protection for all-ins - Dan's call.** Today a disconnected
   player is folded. Some rooms void or protect a hand when a player who is
   all-in or facing no bet drops. Not implemented anywhere; needs a rule
   before code.
10. **`dispose(tableId)` leaks transport-grace timers** (bounded, 8s) and
    `sinceMs` is `lastHeartbeat` rather than a state start for CONNECTED /
    SAT_OUT, which is what makes item 4 possible. Small, worth fixing with 4.
11. **Pre-actions are one-way.** The client pushes them; nothing reads the
    armed pre-action back from a snapshot, so a reconnect can leave the bar
    dark while the engine is armed (or the reverse).
12. **Hole-card recovery is Realtime-bound.** `handleHoleCardPayload` is fed
    by a Supabase channel and a bounded poll; the engine already re-pushes on
    RESYNC. Delivering the hero's cards over the engine socket would remove
    the second transport from the one thing a player cannot play without.

Items 1-5 are engine work with clear code paths; 6-7 are client afternoons;
8-9 need Dan's decision; 10-12 are housekeeping with real upside.
