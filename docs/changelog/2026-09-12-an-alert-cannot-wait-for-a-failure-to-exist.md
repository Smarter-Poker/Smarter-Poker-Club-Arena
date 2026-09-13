# An Alert Cannot Wait For The Failure It Watches For

A Prometheus counter has no series until something increments it, and a rule whose metric has no series evaluates to an **empty vector** rather than to zero. Empty is not greater than a threshold and not less than one, so the rule cannot fire, and it reads on every dashboard exactly like health.

That turns a whole category of alert into one that catches a decline and misses an outage.

## The live case

`HorseCashActionsStopped` is a critical SMS page:

```
sum(rate(poker_actions_fleet_total{audience="horse",format="cash"}[10m])) * 60 < 150
```

`poker_actions_fleet_total` was never zero-seeded. On an engine that started and never got a single horse cash action onto the felt — the **total** failure this alert is named for — that series does not exist. `rate()` is empty, `sum()` of empty is empty, `empty < 150` is empty, and the page never goes out.

Once horses have acted the series exists and the alert works correctly, so it was at its blindest in precisely the worst case. The engine restarted at 23:56 on 2026-09-11; had the fleet manager been broken rather than merely slow, nothing would have said so.

Seeded across its ten-combination label domain, a cold engine publishes `0`, `rate()` is `0`, and the page goes out.

## The fourth shape of one bug

Found on 2026-09-11, all four the same mistake wearing different clothes:

1. **Thirteen metric names with no producer at all**, behind fifteen rules including three SMS pages. Green for seven days while four of the conditions they describe were true.
2. **`poker_hands_total` on a flag-gated registry** enabled nowhere in this estate, leaving `SLOHandsAreNotBeingDealt` (critical, SMS) structurally unable to fire.
3. **Twenty-three dashboard panels** reading metrics that never existed, four of them error-budget panels that render a _full_ budget rather than no data.
4. **This**: a producer that exists but has not run yet.

`check-monitoring-drift.mjs` catches the first three by asking whether anything _emits_ the name. It cannot catch the fourth, because something does. Only running the code answers that question.

## The law

`anAlertCannotWaitForAFailureToExist.law.test.ts` imports the instruments exactly as the engine does at boot, renders the always-on registry, and asks whether the series a rule needs is there before any gameplay has happened.

**Counters only, and the exclusion is reasoned rather than convenient.** A counter has no series until an event increments it, so the event it counts is the thing that makes it visible. A gauge in this module is set unconditionally on every sampler pass in `GameServer` — `horseDecisionWorkerReady.set(worker.phase === 'ready' ? 1 : 0)` and its neighbours — so it has a series within one tick of boot whether or not anything has gone wrong. That block's own comment states the contract: _"absence is represented by worker_ready=0, not a fake healthy scale."_ A gauge that went missing would mean the sampler had stopped, which is a different failure with its own rules.

Six gauges sit in that category — `poker_event_loop_delay_p50_ms`, `poker_main_event_loop_governor_scale`, `poker_equity_governor_scale`, `poker_horse_decision_worker_ready` and two more. All six were checked against the live engine and found present before being excluded here, rather than excluded because including them was inconvenient.

Verified by removing the seed: the law fails, naming the metric and the rule that reads it. Restored: three assertions pass.
