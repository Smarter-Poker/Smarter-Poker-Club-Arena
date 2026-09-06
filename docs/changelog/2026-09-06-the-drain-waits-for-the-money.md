# The drain waits for the money, and the barrier names the right fault

2026-09-06. Phase 1 of the chip-accounting continuation.

## What the board said

Fifteen criticals, `ServerTableEngine.settlement_barrier_abandoned`:

> Table `<id>`: settlement for hand #N exceeded 300s; dealing resumed while it ran

Every one of them carried `waitedMs: 30000`.

## Why that cannot be true

The barrier is

```ts
while (!settled && waited < maxWaitMs && this.running) { ... }
```

with `maxWaitMs = 300_000`. At `waited = 30000` the timeout condition is still
true, so the loop did not time out. It exited on `this.running`, which goes
false when the engine is stopping — and the branch below reported that as an
exceeded deadline, because it never asked which of the three conditions ended
the wait.

The distribution says the same thing. Fifteen rows are three events:

| when (UTC)       | tables               | waitedMs              |
| ---------------- | -------------------- | --------------------- |
| 2026-09-05 16:07 | 5, inside one second | 30000 / 60000 / 75000 |
| 2026-09-05 17:50 | 5, inside one second | 30000                 |
| 2026-09-06 04:10 | 5, inside one second | 30000                 |

Five tables do not independently decide to stall in the same second. One
SIGTERM fanned out five ways, three times. The mixed `waitedMs` at 16:07 is the
signature: each table was at a different point in its 15-second slice loop when
the shutdown reached it.

## The hole the wrong message was hiding

`GameServer.drainHands()` decided a table was parked at a hand boundary with

```ts
return e.isWaitingForHandForHand() || e.isPausedByDesign() || !e.isRunning();
```

`postHandTasks` — the settlement, the rake record, the hand history — is a
promise already in flight, and `running` going false does not stop it. So the
drain reported `N/N parked`, the process exited, and whatever had not been
written was not written. **At :55. Every hour.**

Postgres protects the atomicity of the settlement transaction itself. What it
cannot protect is the rest of `postHandTasks` after that commit — which is
exactly where `fn_rake_repair_unbanked`, `fn_redrive_unbanked_rake` and the
rake-law audit's `board_not_recorded` warnings have been finding their work.

## The fix

1. **The barrier distinguishes shutdown from abandonment.** A shutdown logs one
   line at info and hands the hand to the drain. Only a genuine 300s overrun
   files a critical, and it now interpolates the time actually waited plus a
   `reason: 'barrier_timeout'` rather than printing the cap as if it were the
   measurement.
2. **`drainHands` refuses to call a table parked while `hasSettlementInFlight()`.**
   The check is an early return placed before the stopped-engine shortcut, or
   the shortcut answers first and the check never runs.
3. **The in-flight flag is cleared by the promise, not by the next hand.**
   `postHandTasksPromise` is cleared at the top of the next dealing iteration,
   which is the wrong clock for a drain: a table that stops between hands never
   runs that line again and would hold the 18-second budget open on every
   restart. `settlementInFlight` is cleared by `.then(clear, clear)` and is
   identity-checked, so a stale promise cannot clear a newer barrier.

Pinned by `server/src/engine/TheDrainWaitsForTheMoney.law.test.ts`.

## The fifteen alerts

Closed as MISREPORTED by migration
`20260906092846_the_fifteen_abandoned_settlements_were_three_shutdowns`, which
asserts both counts (15 native, 15 wrapper) and aborts if the board moved
underneath it. No chips moved and none are owed.

They were on the board **twice**: the drift pipeline files a
`drift_incident:financial_alerts:<source>` wrapper beside each native alert, so
thirty rows described fifteen events. That double-filing is its own defect and
belongs to Phase 2.

## Deploy note

This is engine-side. It reaches production through
`auto-deploy-hetzner.yml`, which waits for the `:55` maintenance break — so it
is not running until that lands. The irony is deliberate: the restart this
fixes is the one that ships it.
