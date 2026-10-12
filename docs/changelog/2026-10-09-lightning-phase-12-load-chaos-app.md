# Lightning Phase 12 (App): Load, Stress And Chaos, Surge Protection And The Action-Latency Ledger

Date: 2026-10-09
Scope: engine (`server/src/lightning/`, `server/src/transport/EngineWebSocketServer.ts`,
`server/src/index.ts`, `server/src/GameServer.ts`) and client (`src/`), the app side of
the spec's Phase 20 (LOAD / STRESS / CHAOS) together with SURGE PROTECTION,
INSTANCE PREWARMING, LIGHTNING FIRST-HAND OPTIMIZATION, ACTION LATENCY TELEMETRY,
HOTKEYS and SOUND SYSTEM, plus the Phase 12 client carry-forwards (the auto-rebuy
status line and the responsible-gaming ending).

The database halves ship in parallel: `fn_lightning_latency_report` and the
`latency_telemetry` / `latency_window_ms` config keys on
`agent/claude-lightning-p12/lightning/operator-alerts-db` (20261009144343), and the
`auto_rebuy` object of `fn_lightning_pool_status` plus the `rg_limit` exit reason on
`agent/claude-lightning-p12/lightning/rg-limits-db` (20261009143757). Everything here
tolerates those functions being absent: a missing `fn_lightning_latency_report` is ten
minutes of quiet, never a loop; an older `fn_lightning_pool_status` payload shows no
auto-rebuy line. Lightning is off in production (`lightning_enabled` false on every
Cluster), so none of this runs against real traffic.

## What Was Built

### Engine

1. **The action-latency ledger** (`LightningLatencyLedger`, new, one per Cluster
   worker). Every leg of the spec's ACTION LATENCY TELEMETRY is aggregated per Cluster
   per `latency_window_ms` window into `{n, p50, p95, p99}` and reported through
   `fn_lightning_latency_report(p_cluster_id, p_window_from, p_window_to, p_legs)` under
   the contract's keys: `fold_ack`, `ack_to_idle`, `idle_to_match`, `match_to_hand`,
   `hand_to_first_render`, `fast_fold_to_next_hand`, `normal_fold_to_next_hand`,
   `fold_watch_to_next_hand`.
   - Windows are aligned to the wall clock, except a ledger's first window, which starts
     the moment it records, so a restarted worker or a new process never reports a
     `window_from` its predecessor reported (the database's idempotency key).
   - One flush in flight. A closed window is frozen once into the exact RPC arguments;
     a transport failure retries THAT frozen object after a backoff (5 s doubling to
     60 s, five attempts), so a retry can only replay and never meets
     `IDEMPOTENCY_CONFLICT`. A refusal is final. The queue holds at most six windows.
   - Gated on `latency_telemetry` (read with the database's own rule: only a JSON
     `false` turns it off) and `latency_window_ms` (integer, 10000 → 600000, default
     60000). A window with no sample sends nothing: inert without Lightning traffic.
   - It is never told a card, an action or an amount, and nothing in the matcher reads it.
2. **Hand creation → first client render, measured.** The host reports the moment it
   sends each room the hand's first frame (`onFirstFrame`); the registry keeps one
   pending entry per room and closes it on that room's `RENDER_ACK`, measuring on the
   ENGINE's clock (the client's timestamps are never used). Only the room's owner, only
   for the hand that room was sent, only once, only inside 60 s. A seat whose room has
   no socket simply yields no sample: nothing branches on what the player is. The
   shadow record's `first_render_measured` is now true. `EngineWebSocketServer` accepts
   `RENDER_ACK {hand_id, d}` on the single-table and mux paths (telemetry only, never
   an action).
3. **Surge protection.**
   - One formation in flight per Cluster across every worker object of the process
     (`LightningFormationGate`, new). A worker stopped mid-call leaves the gate held, so
     its successor skips (`formation_in_flight`) instead of overlapping it.
   - The forming call is bounded (`LIGHTNING_FORM_RPC_TIMEOUT_MS`, 10 s). A call that
     does not answer in time is outcome-unknown: the worker keeps its clock, and the
     next pass re-asks under the SAME request id, which the database answers from its
     record; the host refuses an instance it already has, so nothing is dealt twice.
   - Admission micro-batching: a room's first socket (a join or a reconnect) asks its
     Cluster's worker for a pass within `LIGHTNING_ADMISSION_COALESCE_MS` (250 ms), so a
     burst of arrivals shares a few passes instead of waiting a pass interval.
   - A pass the database cut short (`max_hands`, which is `admission_batch_hands`, or
     `time_budget`) is followed at once by the next one, at most eight in a row.
   - The database still owns the budget (`pass_time_budget_ms`, `max_replans`,
     `admission_batch_hands`) and its own per-Cluster pass lock; the suite proves the
     engine never makes that lock refuse it.
4. **First-hand path.** The host's start now asks the hand number and the participants
   alongside `begin_dealing`, and the host rules alongside the time banks once the bind
   names the host table: three sequential round trips where there were six, with every
   refusal still judged in the same order and nothing written before `begin_dealing`
   answers. A room this process has not seen asks the access door and the owner row
   together. Prewarming stops at what is not economic: the room's socket and the felt's
   table shell (seeded from the Cluster) exist before the first hand, and no hand is
   ever formed ahead of a pass.

### Client

1. **The render acknowledgement** (`src/lightning/lightningRenderAck.ts`, new,
   imported only by the lazy TablePage chunk). Once per hand, after the hand is
   committed and the next frame is painted, the pool-session room sends one
   `RENDER_ACK` on its existing table socket: the hand id and a bounded delta, never a
   card (`EngineStateClient.sendRenderAck`, `useEngineTableState().sendRenderAck`).
2. **The auto-rebuy status line** reads the `auto_rebuy` object of
   `fn_lightning_pool_status` (`{enabled, trigger, threshold_bb, threshold_pct, target,
max_count, session_cap, used_count, used_total}`) and is shown only while auto-rebuy
   is on, with the player's own use ("1 Of 3 Used"). The browser no longer asks
   `fn_lightning_config` (service_role only).
3. **The responsible-gaming ending.** `exit_reason` `rg_limit` reads "Your Responsible
   Gaming Limit Ended This Session." in the ended notice, with the seat kept.
4. **Hotkeys** (spec HOTKEYS). The capability row declared them; now they exist: Shift+F
   is LIGHTNING FOLD and Shift+V is FOLD & WATCH, only in a Lightning room whose
   platform row offers hotkeys (desktop), running the fold strip's own handler (the
   engine validates every fold), before the turn too, never while a dialog owns the
   keyboard, never on a table the player is not looking at. Safe modifiers only: plain
   F is unchanged, and Shift+F stays an ordinary F everywhere else.
5. **Sound** (spec SOUND SYSTEM). New hand, your turn, time warning, disconnect and
   reconnect already play through the table's priority gate; an accepted LIGHTNING FOLD
   or FOLD & WATCH now plays the fold cue too, gated on the platform row, the sound
   switch and the table in front, so a multi-table session never stacks cues.
6. **JOIN → HAND.** The hand-off follows the chair the moment the pool session exists;
   it no longer waits for the Cluster's felt metadata (the room asks for it itself). No
   Lightning surface shows technical loading text.

## The Load, Stress And Chaos Suite

`server/src/lightning/LightningPhase12LoadChaos.test.ts`, with
`server/src/lightning/__tests__/lightningLoadChaosKit.ts` (an in-memory world that models the
database contract: the per-Cluster pass lock, request-id replay, reservations,
`begin_dealing` / bind / abandon states, fold and settlement idempotency with
`IDEMPOTENCY_CONFLICT`, chip conservation that freezes, the latency report's key, and
the formation reaper) and `server/src/lightning/__tests__/lightningLoadEngine.ts` (the real
supervisor, workers, hosting, hosts and registry, simulated clients that acknowledge
renders, and a crowd that plays every hand). Horses sit at every table (one in ten). Both
kits live under `__tests__`, which `tsconfig.runtime.json` excludes, so the engine image
never compiles them: the image build's 512 MB compiler heap has no room for them.

Every scenario ends on the spec's required outcome: chips plus rake conserved to the
cent, never a player in two instances, every instance settled exactly once or
abandoned, one receipt per hand and never `IDEMPOTENCY_CONFLICT` or a second request
id, no orphan reservation left by the engine (a crash leaves only what the reaper
voids), the database's pass lock never refusing the engine, at most
`admission_batch_hands` hands a pass, no crash loop, recovery within bounded passes, no
misdirected private frame, and bounded maps once the engine stops. The ledger's reports
are checked against every sample the engine measured, leg by leg.

Populations 10, 50, 100, 500 and 1,000 run in CI; 5,000 and 10,000 with
`LIGHTNING_LOAD_FULL=1`. Chaos: matcher worker crash and restart mid-call, hand host
crash mid-hand, forming-call timeout, connection loss with answers lost before and after
commit, duplicated / delayed / reordered / dropped events (presence, fold, settle,
render), a websocket disconnect storm at 500 players, a server restart rebuilt from the
database state alone, settlement retry, a conversion that is aborted and a freeze.

## Measured Scoreboard (In-Memory World, Milliseconds, P50/P95/P99)

One Node process runs the engine, the world and the crowd together, so these are an
upper bound on engine cost at a given population, not a production forecast.

| Run        | Players / Clusters | Hands | Pass Time         | LIGHTNING FOLD → Next Hand | Normal Fold → Next Hand | FOLD & WATCH → Next Hand | Hand → First Render |
| ---------- | ------------------ | ----- | ----------------- | -------------------------- | ----------------------- | ------------------------ | ------------------- |
| Load 10    | 10 / 1             | 33    | 0.1 / 1.7 / 2.6   | 5 / 14 / 14                | 5 / 28 / 28             | 5 / 9 / 9                | 18 / 34 / 37        |
| Load 50    | 50 / 1             | 89    | 1.3 / 2.8 / 5     | 7 / 17 / 23                | 6 / 15 / 17             | 6 / 10 / 10              | 17 / 33 / 35        |
| Load 100   | 100 / 2            | 139   | 0.2 / 4.6 / 5.1   | 10 / 19 / 23               | 11 / 23 / 30            | 9 / 19 / 26              | 20 / 35 / 37        |
| Load 500   | 501 / 3            | 328   | 1.5 / 11.1 / 13.7 | 63 / 124 / 137             | 57 / 121 / 138          | 54 / 121 / 135           | 30 / 45 / 48        |
| Load 1,000 | 1,002 / 3          | 495   | 1.6 / 20 / 26.3   | 155 / 322 / 479            | 155 / 355 / 475         | 135 / 334 / 504          | 36 / 53 / 62        |

With `LIGHTNING_LOAD_FULL=1` (run locally, the machine otherwise busy): 5,000 players
over 8 Clusters dealt 1,753 hands and 10,000 over 12 dealt 2,746, every invariant
holding, none abandoned. There the single process is saturated: pass time
6.9 / 89 / 115.4 and 30.6 / 230.1 / 468.4, LIGHTNING FOLD → next hand
1,701 / 3,110 / 3,420 and 7,599 / 11,657 / 14,123, render 127 / 180 / 188 and
283 / 571 / 588. That is the engine, the world and a crowd of 10,000 sharing one
thread; it is the ceiling of this harness, not a forecast for production.

Surge, JOIN → first hand: 20 arrivals in 1 s 124 / 264 / 441; 100 in 1.5 s
118 / 258 / 263; 500 in 2 s 149 / 258 / 264 (the 250 ms admission window dominates).
Other legs at 1,000 players: `fold_ack` 0 / 0 / 1, `ack_to_idle` 10 / 19 / 22,
`idle_to_match` 113 / 290 / 446, `match_to_hand` 22 / 47 / 62. Under a forming-call
timeout the fold → next hand P95 rises to about 1.9 s for the hands caught behind it
and recovers once the call answers.

## Laws And Doctrine

- Law 10.5: nothing added reads, filters or branches on `is_horse`; a horse's seat has
  no room socket and so yields no render sample. Horses play in every load population.
- Law 10.6: nothing navigates; the hotkeys only fold, through the strip's handler.
- Telemetry never feeds the matcher: the matcher model has no imports, the ledger reads
  nothing of the matcher or the pool, the worker only configures, ticks and stops its
  ledger, and the forming call's arguments carry nothing measured (source pins).
- Hidden information: the render acknowledgement and the latency report carry no card;
  the suite checks no private frame reaches anyone but its owner.
- No money moves in anything added here; nothing economic is prewarmed.

## Tests

- `server/src/lightning/LightningPhase12LoadChaos.test.ts` (new): the load ladder,
  surge, chaos, the ledger, the render leg, the gate and the source pins.
- `server/src/lightning/LightningPhase11IntegrityShadowApp.test.ts`: the shadow record's
  `first_render_measured` is now true (updated, not deleted).
- `server/src/lightning/LightningShadowWorker.test.ts`: the parsed config carries the
  latency keys (updated).
- `tests/lightning/lightning-phase-12-app.test.tsx` (new): the render acknowledgement,
  the hotkeys, the fold cue and the JOIN → HAND path.
- `tests/lightning/lightning-phase-10-rg-rebuy-app.test.tsx`: the auto-rebuy line now
  reads `fn_lightning_pool_status` (widened, not deleted) and the `rg_limit` ending.
- `tests/lightning/lightning-phase-8-session-app.test.tsx`,
  `tests/lightning/lightning-phase-9-reconnect-app.test.tsx`: the parsed shapes carry
  the new `autoRebuy` and `rgLimit` fields.

## Known Limits

- A forming call that is still unanswered when the whole process stops (leadership loss
  or shutdown) can leave what it formed to the formation reaper, as before: nothing
  moves money, and the reaper voids it.
- The single-process figures above include the world's and the crowd's own CPU.

## Rollback

Revert this change. `latency_telemetry` false on a Cluster turns the ledger off with no
deploy; the render acknowledgement is ignored by an engine that predates it.
