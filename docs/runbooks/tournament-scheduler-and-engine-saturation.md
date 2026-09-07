# Tournament Scheduler And Engine Saturation

Use this runbook when any of these alerts fires:

- `TournamentEliminationSchedulerSaturated`
- `TournamentEliminationSchedulerAllSlotsStalled`
- `TournamentBountyRecoveryLaneFailing`
- `TournamentBountyRealtimeDisconnected`
- `TournamentManagerWakeRealtimeDisconnected`
- `TournamentBountyOutboxBacklogStuck`
- `EngineCoreOutOfHeadroom`
- `EngineCoreSaturated`

The first two rules are diagnostic: do not restart the engine simply because
its queue is non-empty or a tournament promise is slow. Correctness work is
admitted only by a durable state transition, manager admission, or an exact
known deadline; there is no periodic all-tournament repair scan. The saturation
alert requires all four physical slots plus a causal item waiting beyond the
two-minute queue SLO, sustained for another two minutes. The all-slots-stalled
alert independently catches four over-budget physical promises even when the
logical queue is temporarily empty.

## First Checks

Confirm the maintenance break is not active, then read these low-cardinality
series together:

```promql
poker_tournament_elimination_scheduler_registered
poker_tournament_elimination_scheduler_queue_depth
poker_tournament_elimination_scheduler_slots_inflight
poker_tournament_elimination_scheduler_stalled_slots
poker_tournament_elimination_scheduler_oldest_wait_ms
sum by (outcome) (rate(poker_tournament_elimination_scheduler_dispatch_total[10m]))
poker_tournament_bounty_recovery_sweep_inflight
poker_tournament_bounty_recovery_pending
poker_tournament_bounty_realtime_connected
poker_tournament_manager_wake_realtime_connected
sum by (outcome) (increase(poker_tournament_bounty_recovery_sweep_runs_total[10m]))
poker_event_loop_delay_p50_ms
poker_event_loop_delay_p99_ms
poker_equity_governor_sampler_late_ms
poker_equity_governor_scale
```

All of these have fleet or bounded-outcome cardinality. Do not add tournament,
table, or player IDs to them.

## Elimination Scheduler Saturated

1. Check `dispatch_total{outcome="timed_out"}` and `outcome="failed"`.
2. Check the engine error stream for
   `Tournament.elimination_scheduler_run_failed` and elimination-lock warnings.
3. Compare event-loop p50/p99 with PostgREST request latency. A high event loop
   with ordinary database latency is engine-core pressure; ordinary event loop
   with slow or timing-out requests is database pressure.
4. Never decrement `slots_inflight` or release a scheduler slot while its
   promise is unresolved. That hides real concurrency and recreates the fan-out
   this scheduler replaced.
5. A process restart is justified only by the shared engine liveness verdict,
   not by queue depth. Preserve the in-flight hands whenever the process is
   still making progress.

## All Elimination Slots Stalled

This signal does not depend on queue age. It fires when every physical slot has
held the same unresolved promise beyond the warning budget for two sustained
minutes, including the otherwise invisible case where the logical queue is
empty.

1. Compare `stalled_slots` with `slots_inflight`. Fewer than four stalled slots
   means at least one physical lane can still drain queued work.
2. Inspect the oldest unresolved sweep's bounded database operation and the
   `timed_out`/`failed` dispatch outcomes. A timeout is observational: its
   promise still owns the slot until it actually settles.
3. Never release or replace a live promise to make this gauge fall. Doing so
   recreates overlapping sweeps and database fan-out.
4. Use the shared engine liveness verdict—not this alert alone—to decide on a
   restart. When liveness still shows forward progress, repair or reduce the
   blocked work without interrupting active hands.

## Bounty Recovery Failing Or Stuck

An accepted elimination is a durable obligation. A manager or process may die
after the claim is written, but payout recovery must continue from that exact
outbox row and tournament generation.

1. Repeated `outcome="error"` or `outcome="partial"` means the
   Realtime/startup-driven drain cannot read, validate or completely settle
   its bounded batch. Read
   `GameServer.bounty_outbox_recovery_failed`,
   `GameServer.bounty_outbox_recovery_refused` and the database refusal. The
   drain is not called from the five-second tournament discovery loop.
2. A short non-zero `pending` value is expected after a response loss or
   restart. Ten minutes means canonical settlement proof is not being produced.
3. Compare the obligation's generation, hand, exact seat generation, canonical
   claimant weights and snapshotted bounty mode/head with its ledger rows or
   completed mystery award. Do not accept marker existence without amount and
   recipient conservation.
4. Do not edit a player to eliminated, complete the tournament, bypass the
   payer or mark the outbox settled manually. Repair the refused proof and let
   the idempotent event-driven drain finish it.
5. `poker_tournament_bounty_realtime_connected == 0` for two minutes means the
   low-latency delivery channel is down. Startup and channel-error drains keep
   the durable outbox safe, but cross-manager resume can be delayed. Repair the
   subscription/reconnect path; do not add a polling correctness loop.
6. `poker_tournament_manager_wake_realtime_connected == 0` means durable
   late-registration, rebuy and final-table-deal wakes have lost their
   low-latency path. Boot/error drains preserve the receipts, but this channel
   must reconnect before the incident is resolved. Never acknowledge a wake
   merely to clear the backlog.

## Engine Core Saturated

When either p50 or the governor sampler's direct lateness stays above 300 ms,
the core is critically saturated and the equity governor should be at its 0.2
scale or lower. This is not its maximum shedding: at an effective delay of
1,000 ms or more the deep tier should use scale 0.08 and a 30-iteration floor.
Both delay signals are monitored, and either can trigger the alert, because a
long synchronous turn can starve the event-loop histogram that p50 reads.
Sustained delay affects actions, timers, broadcasts, discovery and tournament
work on the same Node event loop.

1. Compare `poker_equity_governor_scale` to the worse of p50 and sampler
   lateness: 300-999 ms should be at most 0.2; 1,000 ms or more should be 0.08.
   A higher scale means the governor itself is unhealthy.
2. Check host CPU and the number of active/dealable tables. This process is
   single-core for JavaScript execution even when the host has spare CPUs.
3. Check scheduler slot/queue metrics to distinguish a tournament-work burst
   from broader engine load.
4. Check PostgREST timeouts separately. Supabase persistence latency can
   amplify the queue, but table state travels over the native engine WebSocket,
   not Supabase Realtime.
5. Do not solve sustained saturation by increasing action or health timeouts.
   Reduce work on the process or add real engine capacity.
