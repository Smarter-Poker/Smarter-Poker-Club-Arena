# Lightning Phase 6 (Engine): The Second Dealing Path

**Branch:** `agent/claude-lightning-p6/lightning/phase6-engine`
**Status:** built and tested; dark in production (no Cluster is Lightning-enabled, `worker_mode` defaults to `off`).

## What Changed

1. **Shared presentation (behaviour-preserving).** The public-state projection of `ServerTableEngine.getTableState` / `broadcastCurrentState` and the hand-event frame literals of `ServerTableEngineHandEvents.handleHandEvent` moved into pure modules, `server/src/engine/presentation/projectHandState.ts` and `handEventFrames.ts`. The engine passes its facts through a context; payload keys, order and reveal gates are unchanged, proven by frozen-copy equivalence tests.
2. **`LightningHandHost`.** One per formed hand: begin_dealing, fn_next_hand_number, fn_lightning_bind_hand_number, host table rules, `HandController` with the barrier's seats (button from the `btn` seat, blinds passed as `blindSeats`), hole cards to their owners only, per-room snapshots and frames through the shared presentation, PreciseActionTimer / TimeBankEngine / DisconnectEngine keyed by the hand, horses through HorseLogic inside the same clock, keepalive, fast fold / normal fold / fold & watch, settlement through `fn_lightning_settle_hand` with one request id, then `fn_ca_process_hand_post_commit_obligations`. Any failure before settlement abandons the instance.
3. **`LightningSeatProxy` and `LightningRegistry`.** POST /action against a pool_session_id routes to the host dealing that room; WebSocket SUBSCRIBE to a pool_session_id is authorized by `fn_lightning_hand_view_access` after the table check answers `table_not_found`.
4. **Worker `form` mode.** `fn_lightning_match_and_form` per pass (fresh request id; the same id only to retry an unknown outcome), a host per formed hand, wake on a freed player or a finished hand, stop on `formation_invariant_failed`. Leadership loss abandons every hand not yet settling.
5. **Latency telemetry.** `poker_lightning_latency_ms{segment}` for fold ack, ack to idle pool, idle pool to match, match to hand and each fold type to next hand.

## Law

`server/src/lightning/ALightningHandsCardsAndMoneyStayWithTheirOwners.law.test.ts`: a Lightning hand's cards reach only their owners and its money moves only through settlement.
