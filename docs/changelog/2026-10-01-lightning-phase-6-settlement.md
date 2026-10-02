# Lightning Phase 6: The Hand Is Numbered, A Fold Frees A Player, And The Hand Settles Onto Its Anchors

Migration `20261001154813_lightning_phase_6_settlement_the_hand_settles_onto_its_ancho.sql`, the database half of dealing. Not applied to production by this change.

## What The Engine And Client Call

- **`fn_lightning_bind_hand_number(p_instance_id, p_hand_number)`** (service_role). Binds the physical allocator's global hand number and the Cluster's front table to a dealing hand, once. The same number answers the same receipt; another number, a number held by another hand or a physical hand, and a number outside 1,000,000 to 2,147,483,647 are refused. Answers `{ok, hand_id, hand_number, host_table_id}`.
- **`fn_lightning_fast_fold(p_hand_id, p_player_id, p_request_id, p_fold_type, p_committed)`** (service_role). `fast` and `normal` record the fold and release only that player's reservation: idle_since is stamped and the matcher may deal them again at once (never IN_HAND). `fold_watch` keeps the reservation until the hand ends. Idempotent on hand and player; emits `fast_fold`, `normal_fold` or `fold_and_watch`. No money moves.
- **`fn_lightning_settle_hand(...)`** (SECURITY DEFINER, service_role). One transaction: the instance locked; a completed hand with the same request answers its stored receipt; an abandoned instance and a stale host lease are refused; every participant named once; `sum(stack_before) = sum(stack_after) + rake + bbj`. Answers `{ok, hand_id, hand_history_id, hand_number, deltas, receipt_hash}`.
- **`fn_lightning_my_session(p_cluster_id)`** (SECURITY DEFINER, authenticated). The caller's own open pool session `{pool_session_id, state, cluster_mode, stack, in_hand, hand_id?}` or `{pool_session_id: null}`. Never an instance id.
- **`fn_lightning_hand_view_access(p_pool_session_id, p_user_id)`** (service_role). True only for the owner of that open pool session.

## How Settlement Reuses The Physical Path

The hand is committed through the unchanged door `fn_ca_commit_hand_settlement` at the Cluster's front table under the bound number: the same lease fence, idempotency key, ca_settlements states, delta-mode stack write and conservation identity, hand_history, hand_projection_outbox, hand_atomic_commits with its post-commit envelope, and provenance receipt. The engine then calls `fn_ca_process_hand_post_commit_obligations(hand_history_id)` exactly as for a physical hand, so rake, jackpot drop and promo playthrough run through `atomic_distribute_rake`, `bbj_record_contribution` and `promo_apply_playthrough` unchanged.

The only adapter: seven seat predicates scoped by `table_id = p_table_id` (four in `fn_ca_settle_hand_stacks_absolute`, three time-bank statements in the door) now compare to the anchor's own table when this transaction's settlement marker names the player, and to `p_table_id` for every physical hand. A Lightning hand's anchors sit at several tables while the hand is recorded at the front table; nothing else in either body changed, and both were substituted by asserted anchors.

## The Settlement Marker Replaces A Forgeable Setting

The anchor guard used to let a stack change through when the session setting `ca.lightning_settlement_hand` named the hand, and any service_role session could set it. The new `lightning_settlement_marker` holds rows keyed by the settling transaction's id and the seat; no role holds a privilege on it, only the SECURITY DEFINER settlement writes it, and it deletes its rows before it returns. The guard now accepts a stack change, and never a departure or occupant change, only when a row names that seat for the current transaction.

## One Anchor In Two Hands

A fast folder is dealt a second hand while the first is still played. Settlement applies `stack_after - stack_before` as a delta under FOR UPDATE, so the two settlements commute. The next hand's `stack_before` is `fn_lightning_pool_stack`, which now subtracts the chips held in live hands the player folded out of: `p_committed` of the fold, or everything they brought into that hand when the engine does not say. The folder never waits for the old hand, is never dealt chips already in the old pot, and the anchor cannot go negative whichever hand settles first. The guard holds the anchor (no cashout, no departure) while any hand the player is in is live.

## Freeze On Disagreement

A conservation failure, a fold that disagrees with its commitment, a released folder who gained, or an anchor that moved is an impossible state: the Cluster goes to `frozen`, `stack_invariant_failed` and `cluster_frozen` are written with the evidence, a critical alert is raised, and the call answers `{ok: false, frozen: true}`. It does not raise, because a raise would roll the freeze back.

## Corrections

Five earlier @live-proofs are superseded and re-proved as containment by the harness:

- r2c#9 (20260926072615 line 147) required the guard to read `ca.lightning_settlement_hand`, the forgeable authority this file removes.
- p9#28, p9#30 (20260925215731 lines 379 and 381) and p9r#31, p9r#32 (20260926023047 lines 380 and 381) forbade any `fn_lightning_` function from being SECURITY DEFINER or executable by a browser role. This phase's contract needs a definer settlement and a definer reader of the caller's own session. Containment: service*role executes every `fn_lightning*`function, the only browser grant is`fn_lightning_my_session` to authenticated, exactly five are definers, and all pin their search path.

## Proof

- `scripts/dev/test-lightning-phase6-settlement.sh`: 14 sections on PostgreSQL 17, port 55553, over the real Lightning chain and the production bodies of the physical path, with humans and horses anchored at the front table and a feeder.
- `tests/lightning-phase-6-settlement.test.ts`: the static contract.
- CI: accounting_postgres shard 1, right after the matcher step.
