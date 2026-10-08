# Lightning Phase 9 (App): Disconnect And Reconnect Across Every Stage

Date: 2026-10-08
Scope: engine (`server/src/lightning/`) and client (Lightning rooms), the app
side of the spec's Phase 14. The DB side (the presence-report writer, the
disconnect reaper in the tick, `fn_lightning_reconnect_state`, the
`disconnect_timeout_ms` config key) ships in parallel on
`agent/claude-lightning-p9/lightning/reconnect-db`; everything here tolerates
those functions being absent.

## What Was Built

### Engine

1. **Presence transitions are reported to the database, on transitions only**
   (`LightningPresenceReporter`, new). When a Lightning player's LAST socket
   in their room drops, or their FIRST socket returns, `LightningRegistry`
   tells the reporter, which batches one Cluster's transitions inside a two
   second debounce (the last state per player wins) and makes ONE call to
   `fn_lightning_presence_report(p_cluster_id, p_disconnected, p_reconnected,
p_now)`. Never per pass. A "function not found" answer (deploy window)
   marks the RPC unavailable for ten minutes and drops batches quietly; a
   failed batch is dropped, not retried, because the per-pass `p_disconnected`
   feed never depended on this call, and the next transition states the same
   fact. Wired at boot in `GameServer` (`lightningRooms`).

2. **Stage coverage, verified against the spec list** (the evidence tests):
   - _before matching / during reservation and forming_: the presence feed
     already withholds a disconnected or unknown player from the deal
     (`LightningPresence` fail-closed buckets; `LightningPhase8SessionApp.test.ts`
     "the presence feed carries platforms", `LightningShadowWorker.test.ts`);
   - _after hand start_: the hand's own `DisconnectEngine` runs the clock and
     the auto-action (check preferred, else fold), the time bank applies, and
     the hand settles entirely server-side with every player gone
     (`LightningPhase9ReconnectApp.test.ts` "runs the clock and the
     auto-action..."; `LightningHandHost.test.ts` "an idle player gets the
     clock, then a time bank, then is folded and freed");
   - _during Fold & Watch_: a watcher's drop just stops publishing; the room
     leaks nothing once the hand ends (new test);
   - _during settlement_: settlement is server-side and completes without the
     client (same new test; `LightningHandHost.test.ts` settlement suite);
   - _during conversion_: the room close and the MUST MOVE notice are Phase
     7's (`LightningPhase7Reversion.test.ts`, `tests/lightning-phase-7-reversion.test.ts`);
   - _reconnect into a live hand_: the transport's `onResync` already asks the
     registry to re-push the player's private state; the host re-sends the
     hole cards to that player's room only, and the hub's `subscribe` hands
     every new socket the current public SNAPSHOT (`TableStateHub`), so a
     returning client reconciles without a special path (new test
     "a returning socket is re-sent the player's own hole cards").

3. **`player_expired` (the DB reaper exits the session)**: `sweepEndedRooms`
   (every 5 s on the leader) closes a room whose pool session has ended, and
   `authorize` refuses a reconnect to it as 4404 - both pinned by the new
   test "an expired pool session answers 4404 on reconnect...". No extra
   event channel was added: the sweep already bounds the window at five
   seconds and the close carries the session-ended reason.

### Client

4. **The 4404 verdict** (`src/lightning/lightningReconnect.ts`, new). Each
   4404 close on a Lightning room asks `fn_lightning_reconnect_state`:
   - session still open -> the reconnect ladder is nudged
     (`reconnectEngineNow`) and the room id never changes;
   - session over -> the room shows the ended notice once, with the ending's
     words ("Your Lightning Session Timed Out" for the reaper's `expired`,
     "Your Lightning Session Has Ended" otherwise), the Phase 8 session
     summary beneath it, and VIEW GAME to the seat that remains, or to the
     Cluster's entry when none does. The MUST MOVE reversion notice (Phase 7)
     takes precedence; the ended-session toast stands down when either notice
     is up. An RPC the database does not have yet changes nothing.
     `LightningEndedNotice` gained optional `eyebrow`/`text` props; every
     existing caller keeps the MUST MOVE defaults.

5. **Pre-actions and the decision queue on reconnect, verified**: an armed
   pre-action names its hand (`STALE_HAND` otherwise), each hand is a new
   host with a fresh `PreActionEngine`, and the client arm is dropped when
   the hand key changes (`TablePage` `lightningArmRef`); the decision queue
   store keeps one entry per hand, re-synced on RESYNC and pruned when a
   retraction was lost on a dropped socket
   (`tests/lightning/lightning-phase-8-session-app.test.tsx` "the decision
   queue store"; `LightningPhase8SessionApp.test.ts` "retracts once ... a
   reconnect re-sends only what is still owed").

## Files

- `server/src/lightning/LightningPresenceReporter.ts` (new)
- `server/src/lightning/LightningRegistry.ts` (transition hooks)
- `server/src/GameServer.ts` (boot wiring)
- `server/src/lightning/LightningPhase9ReconnectApp.test.ts` (new)
- `src/lightning/lightningReconnect.ts` (new)
- `src/components/table/LightningEndedNotice.tsx` (optional wording props)
- `src/pages/TablePage.tsx` (hook, notice, toast guard)
- `tests/lightning/lightning-phase-9-reconnect-app.test.tsx` (new)
