# Lightning Phase 13 (App): Rollout, Drain And Rollback, The Engine And The Player

Date: 2026-10-09
Scope: engine (`server/src/lightning/`, `server/src/GameServer.ts`) and player client
(`src/lightning/`, `src/components/table/`, `src/components/lobby/`,
`src/pages/LightningEntryPage.tsx`, `src/pages/TablePage.tsx`), the app half of the
spec's Phase 22 (OPERATOR CONTROLS, EMERGENCY DRAIN, CLUSTER FREEZE, VERSIONING,
FEATURE FLAGS).

The database half (`fn_lightning_operator_control`, the drain state machine in
`fn_cash_cluster_lightning_drive`, `fn_lightning_rollout_readiness` and the Phase 13
config keys) ships on `agent/claude-lightning-p13/lightning/rollout-drain-db`. The
operator's controls in the club operations page ship on
`agent/claude-lightning-p13/lightning/operator-controls-app`. Everything here tolerates
the database half being absent: a missing key is today's behaviour, a database that
never names the new modes is never asked anything new, and nothing loops. Lightning is
off in production (`lightning_enabled` false on every Cluster).

## What Was Built

### Engine

1. **Holds.** An operator's PAUSE (`cluster_mode` `paused`, or a `paused` marker in the
   config), an operator's EMERGENCY DRAIN (`draining`), Lightning switched off and the
   automatic reversion (`pending_off`) are one thing to a Cluster's worker: a hold
   (`LightningWorkerHold`). Discovery now reads `lightning`, `pending_off`, `draining`
   and `paused`. A held worker forms nothing and calls nothing (no matcher, no
   `fn_lightning_match_and_form`, no admission or wake pass) from its next pass; every
   hand already dealt plays on and settles under its own host, and nothing is
   abandoned. Resume returns the worker to forming in the mode it was paused from, and
   clears the abandon backoff the pause's own voided formations built up, so forming
   starts at once.
2. **The drain reports and stops itself.** A draining pass reports the hands of the
   Cluster still in the air here (`handsInFlight`, and a keepalive log line). When a
   drain or reversion has none left, the worker asks the supervisor to look again
   within `LIGHTNING_DRAIN_RECHECK_MS` (2 s), so the worker stops itself within seconds
   of the database's drive rebuilding MUST MOVE, and the ended-room sweep closes every
   room at once. A restart mid-drain rebuilds from the database alone: the new process
   finds the `draining` Cluster, starts its worker held, forms nothing, and stops at
   MUST MOVE.
3. **The rooms are told.** Every room of a held Cluster receives the private frame
   `lightning_cluster_status` (`{type, cluster_id, status}`, status `ending` for a
   drain, a reversion or Lightning switched off, `paused` for a pause, `null` when it
   forms again), once per change, and again on RESYNC. It carries nothing of any hand.
   Every room is told alike.
4. **The config keys** (`LightningConfig`, third object of `fn_lightning_config`):
   `lightning_joins_enabled` (default true), `drain_timeout_ms` (120000, clamped
   10000 → 3600000), `matcher_version_previous` (`m1`), `matcher_versions_disabled`
   (jsonb array or text[] literal), and the fold flags `lightning_fast_fold` /
   `lightning_fold_watch` (default true, read at the top level or in a `flags` object).
   Only a JSON `false` closes anything; unreadable is today's behaviour.
5. **Matcher versions.** A disabled live version falls back to `m1`, exactly as the DB
   clamps it; a rollback (the operator writing `matcher_version` back to its previous)
   takes effect on the next pass; a disabled shadow version (in
   `matcher_versions_disabled`, or the DB's derived `shadow_matcher_disabled`) leaves the
   shadow runner inactive, so it records nothing (integrity telemetry is untouched).
6. **The fold flags at the action door.** With `lightning_fast_fold` off, LIGHTNING FOLD
   is refused with `LIGHTNING_FOLD_DISABLED` ("Lightning Fold Is Not Available Right
   Now"); with `lightning_fold_watch` off, FOLD & WATCH is refused with
   `FOLD_WATCH_DISABLED`. A refused request marks and moves nothing; the ordinary fold
   on the turn always stands. The flags are read live (an operator's change reaches a
   hand already in the air), and the room's Lightning block carries
   `fast_fold_enabled` / `fold_watch_enabled`.
7. **Joins disabled.** The engine reads `lightning_joins_enabled`; the seated pool plays
   on (the database's pool door and legality hold newcomers).

### Player Client

1. **JOIN LIGHTNING while joins are closed.** `fn_lightning_pool_status` and the lobby
   state's `joins_enabled` false show JOIN LIGHTNING disabled on the Lightning entry
   page with "Lightning Is Not Taking New Players Right Now.", and disabled on the lobby
   card. Players already in the pool are unaffected.
2. **The ending line.** While the engine says a Cluster is `ending`, the room says
   "Lightning Is Ending. Your Game Returns To MUST MOVE After This Hand."
   (`LightningEndingNotice`, lazy with the table view). A paused Cluster says nothing
   technical: the felt's own "Next Hand..." covers the wait.
3. **The drained ending.** `exit_reason` `lightning_drained` ends the session with
   "Lightning Has Ended For This Game." and VIEW GAME to the seat that remains.
4. **The fold strip honours the flags.** A control the Cluster switched off is never
   offered.
5. **Law 10.6.** Nothing navigates on its own: every new surface is words or a
   disabled button; VIEW GAME stays the player's tap.

## Tests

- `server/src/lightning/LightningPhase13RolloutDrain.test.ts`: config keys and clamps;
  held workers (pause, drain, the config's pause marker, admission and wake ignored);
  discovery of the operator modes; room status once per change and on RESYNC; the
  EMERGENCY DRAIN through real hosts with hands in flight (they finish and settle,
  nothing new forms, chips conserved to the cent, the worker stops at MUST MOVE); a
  restart mid-drain; pause and resume through real hosts; joins disabled; matcher
  version disable, rollback and shadow suppression; the fold flags refused at the
  action door with their codes; Law 10.5.
- `tests/lightning/lightning-phase-13-app.test.tsx`: the client against real contract
  rows of 20261009235505 (`fn_lightning_pool_status` with `joins_enabled` and
  `draining`, `fn_cash_cluster_lightning_state` with `joins_enabled`,
  `fn_lightning_reconnect_state` with `exit_reason` `lightning_drained`).
- Widened, never deleted: the Phase 7 discovery pin (`lightning`, `pending_off` now
  lead a longer list), the Phase 6 Lightning block pin, and the Phase 6 config pin.
