# Lightning Phase 7: The Pool Reverts To Must Move And The Tick Drives Both Conversions

Migration `20261001222856_lightning_phase_7_the_pool_reverts_to_must_move_and_the_tick.sql` (specification Phase 10, LIGHTNING -> MUST-MOVE). One transaction, no table created or altered, neither `tables` nor `table_seats` locked by DDL. Every change to an existing body is an asserted substitution into the body PokerIQ-Production carries, checked against `pg_get_functiondef` before commit: each anchor appears exactly once there. Not applied to production by this change. Production has `lightning_enabled` false on all 166 Clusters, so the file ships dark.

## What Was Missing

Nothing in the estate converted a Cluster in either direction. `fn_cash_cluster_begin_pending_on` and `fn_cash_cluster_commit_lightning` had no caller outside the harnesses, and a Lightning Cluster had no way back to the physical tables except the operator's unfreeze.

## Lightning To Pending Off

`fn_cash_cluster_begin_pending_off(p_game_id, p_request_id, p_reason default null)` moves a Cluster from `lightning` to `pending_off` under the Cluster lock when the live eligible population is at or below the OFF threshold (6-max 12, 9-max 18, from `fn_cash_cluster_lightning_thresholds`), or when Lightning or the game is disabled. It opens a `cash_cluster_conversion` row (from `lightning`, to `must_move`, trigger population, both thresholds, `epoch_before`, `chips_at_begin`, request id) and emits `lightning_pending_off`. Formation already refuses every mode but `lightning`, so no new hand forms; a formation not yet dealt is void through `fn_lightning_instance_abandon` and moves no chip; a hand already dealing settles normally, because settlement refuses only a frozen Cluster. Idempotent on the request id.

## Pending Off Back To Lightning

`fn_cash_cluster_abort_pending_off(p_game_id, p_request_id, p_reason)` returns the Cluster to `lightning` when the population rises above OFF before the drain point, enters into the pool anyone who sat down during the drain, aborts the conversion and emits `lightning_pending_off_aborted`. It refuses while Lightning or the game is disabled: a drain begun by switching Lightning off always finishes.

## Pending Off To Must Move

`fn_cash_cluster_commit_must_move(p_game_id, p_request_id)` answers `{ready: false, reason: 'instances_in_flight'}` while any Lightning instance of the Cluster is not terminal. Otherwise, in one transaction, it exits every open pool session (`exit_reason 'lightning_off'`, one `pool_player_left` each), closes every open slot, expires pending reservations, opens the next epoch in `must_move`, clears `dealing_halted_at`, `dealing_halted_reason` and `dealing_halt_observed_at` on every member table Lightning halted so the physical engines deal again, records `chips_at_commit` on the conversion and emits `lightning_off`. It takes an md5 of every column of every seat, cash session and blind ledger row of the Cluster before and after and raises `LIGHTNING_REVERSION_MOVED_MONEY` on any difference: no cash out, no buy in reset, no change to stack, baseline, stay clock, rejoin window, VPIP or join time. Retries are answered `already_committed`.

## The Tick Drives The State Machine

`fn_cash_cluster_lightning_drive(p_game_id)` is one step per Cluster per pass: MUST_MOVE at or above ON begins PENDING_ON; PENDING_ON aborts below ON or when disabled, otherwise asks `fn_cash_cluster_commit_lightning`; LIGHTNING at or below OFF or disabled begins PENDING_OFF; PENDING_OFF aborts above OFF while enabled, otherwise asks the commit. Request ids are derived from the Cluster, its epoch, the direction and its conversion count, so two passes racing on one Cluster open one conversion. Each step runs in its own sub-block; a failure is a `lightning_drive_error` event and a row, never a failed pass. `fn_cash_clusters_tick_all` calls it after the stuck-conversion and formation reaps and before the slot sync, for Clusters with `lightning_enabled` and `must_move` or in a Lightning mode: one read that finds nothing for the 166 disabled Clusters. After a reversion the existing must-move tick, which stands down in every other mode, takes the Cluster on its next pass and plans moves the engine executes at each player's hand boundary.

## The Stuck Pending Off Is Reaped

`fn_cash_cluster_reap_stuck_conversions` now also reaps a PENDING_OFF past its age: every instance still not terminal is abandoned void, then the reversion commits through `fn_cash_cluster_commit_must_move`, whose own money assertion holds. Per-item exception isolation as before; a failure is `lightning_pending_off_reap_failed`.

## My Session Names The Seat

`fn_lightning_my_session(p_cluster_id)` keeps every key it answered and adds `seat_table_id` (the anchor table) for a pooled caller. A caller with no open pool session who holds a live seat in the Cluster now gets `{pool_session_id: null, cluster_mode, seat_table_id, seat_number}`, so the client returns them to their physical table. `fn_lightning_hand_view_access` is false for every exited pool session.

## Proof

- `scripts/dev/test-lightning-phase7-reversion.sh`: 18 sections on PostgreSQL 17, port 55554, over the real Lightning chain with humans and horses at every table. 6-max 18 converts, 17, 16 and 13 hold, 12 drains and reverts, 11 holds; 9-max 27 converts, 26 and 19 hold, 18 reverts; hysteresis abort; Lightning switched off drains; a dealt hand settles in PENDING_OFF before the commit succeeds; an xmin census shows the commit writes no seat, cash session or blind ledger row; every pool session exited, no reservation leaked, halts cleared; four partly filled tables consolidate through must-move plans with no seat written; two backends revert once; a stuck PENDING_OFF is reaped; MUST_MOVE -> LIGHTNING -> MUST_MOVE -> LIGHTNING -> MUST_MOVE with live engines; the tick drives both directions and leaves disabled Clusters alone; grants; every live proof; re-appliable.
- `tests/lightning-phase-7-reversion.test.ts`: the static contract.
- CI: shard 1, right after the Phase 6 settlement harness.
