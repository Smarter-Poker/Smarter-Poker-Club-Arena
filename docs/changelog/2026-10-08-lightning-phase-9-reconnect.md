# Lightning Phase 9: Disconnect, Reconnect and the Forensic Ledger

Migration `20261008050805_lightning_phase_9_disconnect_reconnect_and_the_forensic_ledg.sql` (specification Phases 14 and 15, the database side). One transaction with `SET LOCAL lock_timeout`; the only table altered is `lightning_pool_session`, and neither `tables` nor `table_seats` is locked. Every change to an existing body is an asserted substitution into the body PokerIQ-Production carries, read with `pg_get_functiondef` on 2026-10-08 after `20261008043021`, each anchor counted or the file refuses. Not applied to production by this change.

## Durable Disconnect State

Presence is engine side (the DisconnectEngine owns the sockets); the database is where a disconnect becomes durable, because the matcher, the population and the forensic record all read the database, not a worker's memory.

- `lightning_pool_session.disconnected_at timestamptz`: NULL while connected, stamped when the engine reports the player's logical gaming presence lost, and kept on an exited row for the record. The new check `lightning_pool_session_disconnect_is_dated` says a session in state `disconnected` must carry the stamp. A partial index lists only open stamped sessions for the reaper.
- `fn_lightning_presence_report(p_cluster_id, p_disconnected uuid[], p_reconnected uuid[], p_now)` (service_role): stamps `disconnected_at` and flips `active` to `disconnected` for the disconnected list, clears the stamp and flips `disconnected` back to `active` for the reconnected list, and emits at most one `player_disconnected` and one `player_reconnected` event per call, each carrying its list. Idempotent and event light: a session already stamped keeps its original stamp, and a call that changes nothing writes nothing. Only `active` and `disconnected` flip; a `sit_out`, `leaving`, `joining` or `eligibility_check` session keeps its own state and only carries the stamp. A player named in both lists ends connected. The engine calls it on presence transitions, not every pass. P0 already refuses a `disconnected` session as `DISCONNECTED` and the matcher already diagnoses it `WAITING_FOR_RECONNECT`; this file makes that state reachable.

## Expiry

- `disconnect_timeout_ms` is a new `fn_lightning_config` key, default 180000, clamped to the range 30000 to 1800000 (30 seconds to 30 minutes) and reported in `invalid` exactly as every other number key.
- `fn_lightning_reap_expired_disconnects(p_cluster_id, p_now, p_limit)` (service_role, wired into `fn_cash_clusters_tick_all` beside the formation reaper and isolated the same way): an open pool session disconnected longer than its Cluster's `disconnect_timeout_ms` whose player is not in a live hand and holds no live reservation exits the pool with `exit_reason` `disconnect_expired`, state `closed`, the pool stack recorded as `ending_stack`, its slot closed, one `pool_player_left` per session and one `player_expired` event per Cluster per call. It releases nothing in hand: a player in a live hand is never expired here, the hand's own clock and fold rules own them until it settles, and the next pass takes them once the hand lets go. Clock guarded, bounded, `SKIP LOCKED`, each session in its own sub block. Expired disconnects no longer count in `fn_cash_cluster_live_eligible` once exited; the still seated player is answered by the engine's own `p_disconnected` subtraction until the engine stands the seat up.

## Reconnect Snapshot

- `fn_lightning_reconnect_state(p_cluster_id)` (authenticated and service_role, SECURITY DEFINER, `auth.uid()` scoped): the one door a reconnecting client rebuilds from, the caller's own open pool session as `{pool_session_id, state, in_hand, hand_id, disconnected_at, seat_table_id, seat_number, stack, joinable}`, NULL for anyone else, any other Cluster, or no caller. `hand_id` is the caller's own live hand or null; `joinable` is `fn_lightning_pool_status`'s own formula, never the raw `cluster_mode`; no instance id and no other player's data.

## Event Ledger, Audit and Forensics

- Every pool session exit path now emits `pool_player_left`: the anchor seat trigger and the Phase 7 reversion already did, the new reaper does, and `fn_cash_cluster_unfreeze`, the one writer that exited sessions silently, now records one per session it exits in the same payload shape.
- `fn_lightning_cluster_forensics(p_cluster_id, p_from, p_to, p_limit)` (service_role, read only): the operator's window into one Cluster, its events, conversions, matcher passes, instances and hands of the window in time order, each bounded by the same limit clamped to the range 1 to 2000 (default 500). It names instance ids and other players, which no player door may.
- `fn_lightning_hand_replay_check(p_hand_id)` (service_role, read only): the deterministic audit the specification's Replay Engine asks of persisted state. For a terminal hand it verifies the participant count against the locked count, `stack_before` plus net equals `stack_after` per player, the deltas conserve against the receipt's rake and bad beat jackpot, the receipt agrees with the rows, the six versions are present, and the `hand_created`, dealing and `hand_settled` (or `instance_destroyed`) records exist in order. It returns `{ok, defects}`, one named defect per violated clause, and never repairs.

## Versioning on Conversions

Verified, not rebuilt: `cash_cluster_conversion` already records `from_mode`, `to_mode`, `trigger_population`, both thresholds, both epochs, the request id and the completion status from Phase 5. A live proof pins those eight columns and no column is added.

## Proof

- `scripts/dev/test-lightning-phase9-reconnect.sh`: 15 sections on PostgreSQL 17, port 55556, over the real Lightning chain through the Phase 7 and 8 review fixes, with humans and horses in every Cluster. Every earlier live proof still holds except the one that counted the tick at four isolated sub blocks, which the file restates at five. Configuration defaults and clamps. The presence door's durability, idempotence and one event per call. P0 and the matcher withholding a disconnected player and a reconnect returning them to a real settled hand. Expiry in the idle pool, the population walking the Cluster into `PENDING_OFF` and back, a player in a live hand or a reservation never expired, presence across every mode. The reconnect snapshot's keys, ownership and joinable. The forensic window's order, bounds, read only nature and operator grant. The replay check passing real settled and cleanly abandoned hands and convicting every tampered copy. Every exit path naming `pool_player_left`. The grants. Every live proof; re-appliable.
- `tests/lightning-phase-9-reconnect.test.ts`: the static contract, 37 cases.
- CI: shard 1, right after the Phase 8 harness.
