# Workflow evidence: equity-pool-recovers

- run: wf_07eeee97-2c5
- finished: 2026-09-11T07:56:52.424Z
- status: completed
- agents: 1
- summary: Harden the live equity/insurance worker pool: a queue wait never kills a worker, and an exhausted pool recovers on its own

## status

committed

## branch

fix/the-equity-pool-recovers-on-its-own-claude

## commit

a1b1cfc77302b8d68df2c9f5c2997834d6313c94

## worktree

/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-equity-pool-2

## summary

The fix is committed locally as a1b1cfc773, on top of origin/main 53edbd4d10. It is not pushed. It is on a different branch and worktree from the ones I was given, because another agent was committing on those (see the first concern).

The mechanism is as described. On main, enqueue() armed each job's only timer at enqueue. When that timer fired on a job that was already running, onJobTimeout retired the healthy worker and respawned it. Only a completion refilled respawnBudget. Once the budget was spent, scheduleRespawn set phase to 'failed', and nothing ever called spawnWorker again.

What changed in server/src/engine/equity/EquityWorkerPool.ts:

1. Two separate budgets.
   - **Queue budget:** jobTimeoutMs, counted from enqueue. A job no worker has started by then is removed from the queue and rejected with EquityWorkerTimeoutError (new field stage: 'queue'). It touches no worker, spends no respawn budget, is counted in queueExpirations, and does not overwrite lastError.
   - **Execution budget:** jobTimeoutMs, counted from dispatch (postMessage). This is the only deadline that retires a worker. Before it does, the pool waits one setImmediate turn, the same grace the live horse client uses, so an answer that arrived during a main-thread stall is read first.
   - A caller waits at most 2 x jobTimeoutMs.
   - Insurance still jumps ahead of cosmetic equity in the queue, first-in-first-out within each class.
   - Both timeout messages keep the old prefix 'Equity worker operation timed out after Nms'. They add either 'waiting in the queue; no worker was touched' or 'of worker execution'.

2. Recovery after the budget is spent.
   - The pool now schedules a recovery instead of ending. It stays 'failed' if no workers are left, 'degraded' if some are.
   - With no workers left, new work is rejected immediately and anything queued is failed at once.
   - After the cooldown it refills the budget and spawns back to size. The cooldown is 30 s, doubling to 5 min while recoveries end without a completion; the first completion resets it. Both are options: recoveryCooldownMs and maxRecoveryCooldownMs.
   - A respawned or recovered worker must send READY within readyTimeoutMs or it is retired. Without this, one hung boot could hold its slot and block recovery forever. The first boot is still bounded by ready().

3. Timers.
   - Every new timer is unref'd.
   - shutdown() cancels a pending recovery, pending respawns (now tracked) and replacement READY deadlines.

status() and /health: every existing field and phase is unchanged. New fields are queueExpirations, executionTimeouts, respawnBudgetRemaining, nextRecoveryAt (epoch ms or null) and recoveries. The no-pool default in equityWorkerPoolStatus() has them too. /health shows them automatically under equityWorkerPool. GameServer.ts is untouched.

Other files:

- EquityWorkerOnly.test.ts: the old timeout test is renamed and advances 26 ms instead of 25, because the fake clock runs the grace turn 1 ms later.
- A changelog entry is at docs/changelog/2026-09-11-the-equity-pool-recovers-on-its-own.md.

## tests_run

All run from server/ with `npx vitest run`, detached.

- Final run: src/engine/equity/ (5 files), src/engine/PineappleAllInEquity.test.ts, src/engine/InsuranceRitExclusivity.test.ts and src/engine/SyncMonteCarloWorkerBoundary.guard.test.ts. 8 files, 54 tests, all pass.
- These are every test in server/src that references EquityWorkerPool, getEquityPool or equityWorker. Nothing in the repo-root tests/ references them.
- EquityWorkerPool.test.ts now has 14 tests: the 4 existing ones plus 10 new. 9 use a scripted fake worker on the fake clock; 1 uses a real worker thread.
- The new tests cover:
  - a 12-job burst whose queue deadlines lapse;
  - a 3-second surge at 3x the worker's capacity with the production respawn budget of 10;
  - an execution timeout still retiring its worker;
  - an answer that arrived during a 400 ms main-thread stall being accepted (real worker);
  - insurance still outranking cosmetic equity, with the stale equity shed;
  - recovery after the cooldown, serving again;
  - the cooldown doubling to its cap and resetting after a completion;
  - a hung replacement boot being retired and recovery then succeeding;
  - shutdown() during a cooldown leaving no timer armed;
  - shutdown() with a respawn or a replacement boot pending leaving no timer armed.
- Flakiness check: EquityWorkerPool.test.ts plus EquityWorkerOnly.test.ts 5 times in a row (30/30 each), and src/engine/equity/ as 4 runs at once (44/44 each).
- `npx tsc -p tsconfig.json --noEmit` in server/: exit 0.
- prettier --write on the changed files, and lint-staged's prettier ran again at commit.

## proved_failing_on_old_code

I temporarily put origin/main's EquityWorkerPool.ts back (`git show origin/main:server/src/engine/equity/EquityWorkerPool.ts`), ran the new tests, then restored my version (checked identical with cmp). All 10 new tests fail on the old pool. The existing EquityWorkerOnly tests still pass on it.

The two required ones fail on behaviour, not just on the new fields:

- **Burst test:** `expected [ true, true, true, false ] to deeply equal [ true, true, true, true ]`. The 4th job, dispatched with 10 ms of queue budget left, was killed as an active timeout, and its healthy worker was terminated.
- **Recovery test:** `expected [ ScriptedEquityWorker, … ] to have a length of 3 but got 2`. No worker is ever spawned after the cooldown; the pool stays 'failed' for good.

Other behavioural failures on the old pool:

- **Surge test:** `expected { phase: 'failed' … } to match { phase: 'ready' … }`, with readyWorkers 0. That is the production /health state, reproduced.
- **Stall test:** `promise rejected "EquityWorkerTimeoutError: Equity worker operation timed out after 50ms" instead of resolving`.
- **Hung-boot test:** the replacement's terminateCalls is 0; the hung slot is never retired.
- **Shutdown during cooldown:** timer count is 0 where 1 is expected, because the old pool never arms a recovery.
- **Shutdown with a respawn pending:** timer count is 1 where 0 is expected; the respawn timer survives shutdown().

Three tests fail on the old pool only because the new fields are missing: the execution-timeout test and the insurance-order test (stage is undefined), and the cooldown-doubling test (nextRecoveryAt is undefined, so NaN).

## concerns

```json
[
  "WORKTREE COLLISION, please sort out before merging. At 02:28 CDT, while I was still reading code, another agent committed on the branch I was given (fix/the-equity-pool-recovers-on-its-own), inside the worktree I had just created (~/Documents/.agent-trees/club-arena/claude-equity-pool). The commit is 'fix(engine): keep slow equity workers recoverable', first 3e1ab47eb2, since amended to 35578a0ed0. It is authored Smarter-Poker with no Claude trailer; Codex is running on the Mac. I did not touch it, and put my work on branch fix/the-equity-pool-recovers-on-its-own-claude in worktree claude-equity-pool-2. Its design differs from mine and conflicts with it: a caller timer from enqueue plus a 15 s hard execution timer, new routingReady / acceptingWork / recoveryInFlight status fields, and a GameServer /health change so a recovering pool still reports 'ok'. It also changes real-money insurance pricing in equityWorker.ts: it caps sampled preflop runouts for multi-way Omaha at an evaluation budget, and cuts the exact-enumeration threshold from 20,000 combos to at most 6,000. It has no cooldown, so a spent budget is still permanently 'failed' there. Merge one of the two, not both.",
  "Live horse decision client (server/src/engine/horseDecision/client.ts): it does NOT have the enqueue-armed-timeout-kills-worker pattern any more. #4190 (c4881fea3b) split the timers. The deadlineTimer, armed at enqueue (8 s), only rejects the caller: a queued job is removed ('expired before worker dispatch'), and an active one gets CANCEL posted while the worker is kept. A separate executionTimer, armed at dispatch, with a setImmediate grace, is the only thing that calls fail(). That is why its 1,718 'expired before worker dispatch' lines in the surge were harmless shedding and it recovered. It cannot go permanently dead in-process: fail() is terminal by design (one FIFO worker owns the RNG and learned memory), and onFatal in GameServer revokes dealer prerequisites and rethrows, so the process restarts. The residual risk is the opposite one: one decision taking more than 8 s of wall time under CPU starvation restarts the whole engine and voids live hands. I changed nothing there.",
  "Other worker clients: HorseLeagueComputeWorkerClient (server/src/benchmark) runs one job at a time and throws if busy; its heartbeat timer is armed at dispatch, so it has no queue and no such pattern. ShardManager (server/src/scale) is not wired into GameServer.",
  "/health is coupled to this pool. GameServer.getStatus() reports 'ok' only when the equity pool's phase is 'ready', and handleHealth answers 503 otherwise; Caddy routes on that code. So the production leader has probably been answering 503 since about 07:00 because of this pool. With the fix, any respawn window and any cooldown (30 s up to 5 min) also answers 503, as degraded capacity always has. Whether an optional calculator should take a dealing leader out of routing is a product call; I left GameServer alone.",
  "Production is still 'failed' now and will stay so until the next restart or deploy. There is nothing to settle: every failure was fail-closed (percentages omitted, insurance not offered), so no price was computed wrong and no contract was written.",
  "The latency ceiling changed. A caller can now wait up to about 2 x jobTimeoutMs (5 s): queue wait plus the execution budget. pacedAllInRunout awaits broadcastAllInEquity on every street, so a genuinely wedged worker can now hold a street for up to about 5 s instead of 2.5 s. With a healthy worker, execution is milliseconds.",
  "The new status fields appear on /health only. They are not exported as Prometheus gauges; queueExpirations and nextRecoveryAt would be worth adding to engineInstruments.ts. Every shed job still reaches reportError (all_in_equity_worker_failed / insurance_pricing_worker_failed), so Sentry volume during a surge is unchanged; the message now says which budget ran out.",
  "The execution grace uses setImmediate. Vitest's fake clock runs an immediate created during a tick 1 ms later, so the existing EquityWorkerOnly timeout test now advances 26 ms instead of 25. The grace itself is proven by a real-worker test: a 400 ms main-thread stall, stable over 5 serial runs and 4 parallel ones."
]
```
