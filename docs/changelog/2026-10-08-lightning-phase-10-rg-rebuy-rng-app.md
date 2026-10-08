# Lightning Phase 10 (App): Responsible Gaming, Auto-Rebuy And The Hidden-Information Review

Date: 2026-10-08
Scope: engine (`server/src/lightning/`) and client (Lightning rooms), the app
side of the spec's Phases 16 and 17. The DB side (`fn_lightning_stop_playing`,
`fn_lightning_auto_rebuy`, the auto-rebuy and RG keys in
`fn_lightning_config`, the RG refusal codes at the entry door) ships in
parallel on `agent/claude-lightning-p10/lightning/rg-rebuy-rng-db`; everything
here tolerates those functions being absent (deploy window): a missing
function means the feature is quietly unavailable, never a crash loop.

## What Was Built

### Engine

1. **Auto-rebuy runs between hands only** (`LightningAutoRebuy`, new). The
   hand host reports the SETTLED boundary: after `fn_lightning_settle_hand`
   answered ok and before `finish()` hands anyone back to the matcher, it
   names the players this boundary releases with the stacks settlement left
   them (`onHandSettled`, awaited). A player a LIGHTNING fold or a normal
   fold already freed is not named: they may be in another live hand, and
   their boundary is that hand's settlement. The executor then makes at most
   ONE `fn_lightning_auto_rebuy(p_cluster_id, p_player_id, p_now)` call per
   player per boundary, only for stacks at or under the configured trigger:
   - config disabled, or the trigger unreadable: no call at all;
   - "function not found" (deploy window): quietly unavailable for ten
     minutes (the presence reporter's pattern);
   - a refusal or an error: terminal for that boundary, never retried;
   - log-light: rate-limited lines, never one per hand.
     The database does all money movement and validation; the engine only
     asks. Wired at boot in `GameServer` (`lightningHosting.autoRebuy`).

2. **The auto-rebuy config keys** (`LightningConfig`): `auto_rebuy_enabled`,
   `auto_rebuy_trigger` (`bb` or `pct`), `auto_rebuy_threshold_bb`,
   `auto_rebuy_threshold_pct`, `auto_rebuy_target`, `auto_rebuy_max_count`
   and `auto_rebuy_session_cap` are parsed beside the worker's own keys,
   bounded, failing closed to "off, asking nothing". Each formed hand
   carries the config its forming pass ran on.

3. **Stop playing is honored by construction**: the database refuses new
   hands for a stopping or RG-blocked session, the matcher stops naming the
   player, and the engine deals ONLY what the matcher formed - there is no
   engine-side RG filter to get wrong, and the new tests pin that none
   exists (no `is_horse` and no RG re-derivation in any Phase 10 surface,
   CLAUDE.md 10.5). When the session exits after its last hand, the existing
   room sweep closes the room and the Phase 9 reconnect flow answers the
   client.

### Client

4. **The Stop Playing control** (`LightningRoomTools`). A Lightning room IS
   the player's queue and their seat, so the control lives in the room's own
   tools strip, next to Session and Recent Hands, while queued between hands
   and while seated in one alike. One tap calls
   `fn_lightning_stop_playing(p_cluster_id)` (`stopLightningPlaying`, new in
   `lightningSessionApi`):
   - a database without the function yet gets one toast, "Stop Playing Is
     Not Available Right Now.", and the control stays usable;
   - accepted with a hand live: the control says "Finishing Current
     Hand..." and stays disabled; the session ends when the hand settles,
     the room closes, and the Phase 9 ended notice takes over;
   - the ending carries the player's own words: `fn_lightning_reconnect_state`'s
     `exit_reason` of `stop_playing` reads as "You Stopped Playing." in the
     existing `LightningEndedNotice` (a database that does not send the
     field keeps the Phase 9 words). Law 10.6 stands: nothing navigates;
     VIEW GAME stays tap-only, and the pin counting the page's two
     seat-moves is restated in the Phase 10 suite.

5. **Hand volume, always on screen** (`lightningSessionMetrics`, new).
   Lightning deals a very high hand volume, so the room's tools strip now
   carries one line: hands this session, duration, hands per hour. One
   `fn_lightning_session_stats` read on mount is the baseline; every new
   hand key on the felt ticks the count locally; the clock ticks locally
   while the room is on screen; the Session panel's own per-hand read
   re-baselines it for free. No new polling.

6. **The auto-rebuy status line**. Auto-rebuy is operator-level
   configuration, so the Session panel shows it read-only: "Auto-Rebuy:
   Off", or "Auto-Rebuy: On (Below 20 BB → 100 BB)", from one
   `fn_lightning_config` read when the panel opens. Unreadable (function
   absent, not granted) shows nothing at all.

## The Hidden-Information Review (Spec Phase 17)

The audit walked the deal and transport path and then pinned it with tests.

**Verdict: no leak found.** Specifically:

- **The shuffle and the deal are server-side.** A Lightning hand's deck is
  built and shuffled inside `HandController` in the engine process
  (`secureShuffle`, the rejection-sampled crypto Fisher-Yates every table
  uses); the order is fixed before the first card moves and no client input
  reaches it.
- **Hole cards go only to their owner's sockets.** The host has exactly one
  `hole_cards` send site and it is `sendToUser(room, playerId, ...)` to the
  owner's own pool-session room (the Phase 6 law pins the site count; the
  Phase 9 re-push goes through the same door). The durable copy goes through
  `insert_hole_cards`, the physical path's row the client re-reads under its
  own entitlement.
- **No other player's hidden cards in any client payload.** Room snapshots
  are `projectLiveHandState` with the shared reveal rules; events are the
  shared `handEventFrames` builders. The new frame walk simulates full
  hands, walks every frame type each room received
  (`hand_started` → `showdown_cards_revealed` → `hand_complete`) and asserts
  that before the showdown frame NO room holds any other player's hole
  cards, and after it only the tabled, non-mucked ones - the spectator and
  FOLD & WATCH streams are these same frames. The all-in runout reveal is
  the engine's existing tabling rule, not a leak.
- **No hole cards in logs.** A recording logger ran settled, abandoned and
  post-commit-retry hands; no line carried a card, and the pin is not
  vacuous (lines were produced, cards were dealt).
- **The durable record keeps only what was shown.** The settle row's
  `players` carry no cards, its `actions` carry none, and `hole_cards` holds
  only tabled showdown hands.
- **The replay and recent-hands surfaces ask only authorized doors.**
  `fn_lightning_recent_hands` answers for the caller only, and the replay
  modal opens the existing `HandReplay` by `hand_histories` id - the same
  component with the same entitlement rules as every replay in the app.

## Files

- `server/src/lightning/LightningAutoRebuy.ts` (new)
- `server/src/lightning/LightningConfig.ts` (auto-rebuy keys)
- `server/src/lightning/LightningHandHost.ts` (the settled-boundary seam)
- `server/src/lightning/LightningRegistry.ts` (hosting wiring)
- `server/src/GameServer.ts` (boot wiring)
- `server/src/lightning/LightningPhase10RgRebuyApp.test.ts` (new)
- `src/lightning/lightningSessionApi.ts` (stop playing, auto-rebuy status)
- `src/lightning/lightningSessionMetrics.ts` (new)
- `src/lightning/lightningReconnect.ts` (`exit_reason`, the stopped ending)
- `src/components/lightning/LightningRoomTools.tsx` (the control, the volume line)
- `src/components/lightning/useLightningSessionData.ts` (status read)
- `src/components/lightning/LightningSession.css`
- `tests/lightning/lightning-phase-10-rg-rebuy-app.test.tsx` (new)
