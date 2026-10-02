# Lightning Phase 6 Remediation: A Frozen Cluster Settles Nothing

Migration `20261001201216_lightning_phase_6_remediation_a_frozen_cluster_settles_nothi.sql`, fixing review findings against the Phase 6 settlement (`20261001154813`) and the matcher (`20260926080332`). Every change is an asserted substitution into the body production carries, checked against `pg_get_functiondef` on PokerIQ-Production before commit: each anchor appears exactly once there. Not applied to production by this change.

## The Freeze Freezes From Every Live Mode (P0)

`fn_lightning_settlement_freeze` froze only `WHERE cluster_mode = 'lightning'`. A conservation failure on a hand still settling after its Cluster moved to `pending_off` or `draining` wrote `stack_invariant_failed` and `cluster_frozen` and answered `frozen: true` while freezing nothing. It now locks the Cluster row, freezes from any mode except `frozen` and `dead`, and records the real `from_mode` in `cluster_frozen`, in the alert and in its answer. It answers `frozen: true` only when the Cluster is frozen: by this call, or already (`already_frozen: true`, with no second `cluster_frozen` event and no second alert). A dead Cluster is answered `frozen: false` and only the evidence event is written.

## A Frozen Cluster Settles Nothing (P0)

`fn_lightning_settle_hand` answers `{ok: false, reason: 'cluster_frozen', retry: false}` for a hand whose Cluster is frozen, right after it finds the instance dealing and before the marker, any seat or the hand row is written. The engine already abandons the instance on any refusal that is not `frozen` (`settlement_refused:cluster_frozen`), and `fn_lightning_instance_abandon` is not gated on the freeze, so the hand ends with every anchor stack exactly as it was and its players are released. A hand settled before the freeze still answers its stored receipt on retry.

## The Session Names Its Anchor Seat (P1)

`fn_lightning_my_session` keeps every key it answered and adds `anchor_table_id`, `seat_number` and `occupancy_id`: the caller's anchor seat, by the `table_seats` columns the physical leave path takes (`fn_cashout_seat_occupancy(user, table, seat_number, occupancy_id)`). The client leaves and adds on through the anchor table with them.

## The Matcher Forms Nothing The Host Cannot Deal (P1)

The Lightning host abandons a pineapple hand at begin, because the discard round needs the physical discard pipeline. `fn_lightning_match_plan`, and so `fn_lightning_match`, now answers a Cluster whose `cash_games.variant` is `pineapple`, or whose front table (the host's rules) has `game_variant = 'pineapple'` or `pineapple_holdem`, with no groups, `refused: true`, `reason: 'variant_not_supported'`, and every open-pool player diagnosed `BLOCKED_WITH_REASON` / `VARIANT_NOT_SUPPORTED`. `fn_lightning_match_and_form` refuses up front, before the pass lock and unrecorded like `worker_mode_is_not_form`, with `cluster_has_no_front_table` when `fn_cash_cluster_front_table` is null and with `variant_not_supported`.

## Leave Pending Mid-Hand Needed No Change

The anchor guard trigger fires only when `stack`, `left_at` or `user_id` change, so setting `leave_pending` on the anchor of a player in a live hand goes through and the pool session stays open. A stack change or a departure is still refused `PLT01` until the hand settles; after it, the departure goes through and the unchanged pool-follows-seat trigger exits the pool with the settled stack.

## Contract Changes

- Engine: `fn_lightning_settle_hand` may answer `reason: 'cluster_frozen'` (no `frozen` key), which the host already turns into an abandon. The freeze answer adds `already_frozen`, `from_mode` and `cluster_mode`. `fn_lightning_match_and_form` may answer `ok: false` with `cluster_has_no_front_table` or `variant_not_supported`, which the worker already reports as a refused pass.
- Client: `fn_lightning_my_session` adds `anchor_table_id`, `seat_number` and `occupancy_id`.

## Proof

`scripts/dev/test-lightning-phase6-settlement.sh` now carries eight more sections on the same estate, after the Phase 6 file: 14 the defects are real before the remediation; 15 the freeze from every live mode and never from dead; 16 a frozen Cluster settles nothing, its dealing hands abandon with every stack unchanged, and a settled hand still replays; 17 the session names the anchor seat at a feeder and at the front table; 18 the matcher refuses pineapple, pineapple hold'em on the host table and a Cluster with no front table, against an nlh control that forms; 19 leave pending mid-hand, the departure after settlement; 20 every proof of the remediation is true and every earlier Lightning proof evaluates exactly as before; 21 the remediation is re-appliable. `tests/lightning-phase-6-settlement.test.ts` reads the file statically. Law 10.5: nothing reads `is_horse` or `horse_id`; horses are frozen, refused, matched and diagnosed as humans are.
