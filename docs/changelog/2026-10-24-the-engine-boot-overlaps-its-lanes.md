# The Engine Boot Overlaps Its Lanes And Names Where Its Time Goes

A cutover is admitted only while the candidate reaches HTTP 200 with `dealerPrerequisitesReady` inside a fixed budget. On 2026-10-24 release e4f793b6 took about 63 s from launch to readiness (de8ada47 about 96 s) and both rolled back; the only evidence of where the time went was the silence between unrelated log lines.

## What ran one after another, and what now overlaps

After leadership is decided, `GameServer.performStart` used to await, in order: the horse decision lane (8 workers, each hydrating HorseMind and the solver stores before READY), then the equity worker pool (14 workers), then the stale-data cleanup (its fleet-wide `tables` status reset is 1.1 s mean and 7.6 s max in `pg_stat_statements`; the dead-lease reaper 0.16 s mean, 4.1 s max), then the rake spec check. None of them reads or writes what another owns and none admits a table, so they now start together and the boot joins both lanes at the point it used to wait for the last of them. Leadership is still decided first (a standby starts none of them), the cleanup still finishes before break adoption and before any discovery loop exists, both lanes are still READY before break adoption, discovery and the dealer gate, and a lane failure is still fatal to the boot.

Inside each horse decision worker, the durable mind read (`horse_mind_pairs` is twenty serial pages, 156 ms mean each) used to be awaited before the exploit replay and the chart, open-node and V31 loads started. Only the mind replay depends on it, so that pair stays one chain and everything else starts beside it. READY still waits for all of them.

## The breakdown is now published

`engine/bootPhases.ts` records each boot phase's start and end from process start. Each phase prints `[BootPhase] <name> <outcome> in <ms>ms (started ..., ended ... after process start)`, the dealer gate prints one summary line, and `/health` carries `bootPhases` (`processStartedAt`, `dealerReadyMs`, and every phase). Each decision worker prints `[HorseDecisionWorker] shard N boot step <name> <outcome> in <ms>ms`, so the container log names the read that held READY.

## Expected effect, and what was not measured

The equity pool start and the cleanup (normally about 1.5 s, up to about 12 s on a slow database) leave the critical path, and each worker's mind read (about 3 s) overlaps its exploit replay. Neither saving was measured on engine-01; the next cutover's `bootPhases` is the measurement. The largest remaining cost is visible in the data rather than fixed here: every one of the 8 workers reads the same rows independently, about 350 MB of JSON each per boot (the exploit replay alone is about 158 MB, 90% of it the `publicNode` and `observationIdentity` action fields neither consumer reads), so about 2.8 GB crosses the network per start.

Pinned by `server/src/engine/bootPhases.test.ts`, `server/src/engine/horseDecision/workerPreparation.test.ts`, and the moved order pins in `LiveHorseDecisionWorkerLifecycle.guard.test.ts` and `EquityWorkerCapacity.guard.test.ts`.
