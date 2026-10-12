# Lightning Phase 6 Engine Remediation

**Branch:** `agent/claude-lightning-p6r/fix/engine-review`
**Status:** built and tested; Lightning remains dark in production (no Cluster is Lightning-enabled).

Fixes every finding from the Phase 6 engine review (`server/src/lightning/*`, merged in #5697).

## What Changed

1. **Bad Beat Jackpot (P0).** `LightningJackpot.ts` runs the physical settlement path's jackpot step after a successful `fn_lightning_settle_hand`: `detectBBJHit`, then `detectMiniBBJHit` only when the main refuses, gated on the host table's `bbj_percent`, a showdown of two or more and a winner; payment through `processBBJPayout` / `processMiniBBJPayout` (write-ahead claim, retries, queue, freeze deferral, one idempotency key per pool, table and hand); the same `bbj_hit`, `bbj_payout_pending` and `bbj_payout_complete` events to every participant's room. `seatedUserIds` is empty because no participant is seated at the host table, so every share is credited directly, the branch the physical path already uses for a recipient who has left. Amounts are identical. The operator drill is a physical-table instrument and is not claimed by a Lightning hand.
2. **Frozen Cluster (P0).** The supervisor's `onFrozen` also calls `hosting.abortCluster(id, 'cluster_frozen')` (hands already settling are left alone). A settle answering `{ok:false, reason:'cluster_frozen'}` abandons the instance (nothing moved) and stops the worker.
3. **No zero-delay re-form loop (P1).** The worker is woken only by a settled hand or a folded (released) player, never by an abandon. Consecutive abandons back a Cluster off (0.5 s doubling to 30 s), cleared by a settled hand. `formPass` refuses to form while backed off or when this process holds no verified lease on the Cluster's front table (`fn_cash_cluster_front_table`, cached 30 s).
4. **Idle shape on fold and abandon (P1).** A fast or normal fold publishes the idle shape (stage `waiting`, no players, `hand_id` null, `fast_fold_available` false) to the folder's room before the hand stops publishing there; an abandon after the deal started idles every room still shown the hand.
5. **Leaving from a Lightning room (P1).** The anchor table engine's `leaveTable` asks `fn_lightning_player_live_hand` first and, while the seat anchors a live hand, records the durable `leave_pending` request instead of attempting a cash-out; the existing sweep cashes out after the hand settles. `/leave-occupancy` and `/addchips` with a `pool_session_id` resolve to the anchor seat (`lightning_pool_session.anchor_seat_id`) through `GameServer.lightningAnchorFor` instead of answering 503 or "not found".
6. **Post-commit drain (P1).** `postCommit` now returns `{ok, reason}`; the host ports the physical bounded drain: `ok !== true` (including `predecessor_pending`) is retried with backoff for up to 15 s while the host lease is held, 5 s after it is lost, then files the critical financial alert. The outbox row remains authoritative.
7. **Time bank across concurrent hands (P1).** A folder's bank is recorded at the fold and `finish()` skips anyone already recorded; the ledger keeps the minimum remaining; paid seconds go to `fn_consume_time_bank` with `lightningRequestId(handId, 'tb/' + userId)`, awaited with retry, and an unanswered debit stays owed. A bank first seen by a worker is seeded from the durable bank (the allowance is net of every debit; the free part is capped by the anchor seat's persisted `time_bank_remaining`).
8. **Horses decide in the live lane (P2).** `LightningHorse.ts` builds the physical decision snapshot (hero's own cards only, the controller's chip rules, legal menu and pots, the horse's own style and mods from `horse_profile`) and asks `getLiveHorseDecisionWorker().decideFast` under the turn-clock deadline. Think time and action shaping are the physical engine's; a failed job gets the liveness answer, and there is no synchronous brain on the main loop.
9. **Ended rooms are closed (P2).** `EngineWebSocketServer.closeRoom(tableId, reason)` retires single-table sockets with 4404 and unsubscribes mux sockets with `TABLE_NOT_FOUND` ("Your Lightning Session Has Ended"). `LightningRegistry.sweepEndedRooms()` runs every 5 s from the supervisor and closes socketed rooms with no hand whose view access is now refused; `unregister` checks rooms not moving to a new hand.
10. **Replayed pass (P3).** `LightningHosting.hasInstance` also sees hosts that are still starting.

## Law

`ALightningHandsCardsAndMoneyStayWithTheirOwners.law.test.ts` and its `docs/laws.d` entry now name the jackpot: after a successful settlement only, through the physical payout doors, every share credited directly.

## Known Limits

- Second-look (deep) horse decisions and the execution-witness ledgers of the physical horse path are not run for Lightning horses; the decision itself, its timing and its effects commit are.
- Seconds of the free base bank spent in Lightning before a worker restart are capped by the anchor seat's persisted bank, not by a Lightning-specific record (no Lightning source may write a seat).
