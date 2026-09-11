# The Equity Pool Recovers On Its Own

2026-09-11. Production lost live all-in equity and all-in insurance pricing at
06:57-07:00 UTC and did not get them back.

## What was wrong

The engine restarted, the thaw resumed 955 tables, and a tournament catch-up
surge followed: 1,927 tournament hands in two minutes, about 15x normal. From
then on `/health` said

    {"phase":"failed","configuredWorkers":1,"readyWorkers":0,
     "lastError":"Equity worker operation timed out after 2500ms"}

with 5,267 `EquityWorkerUnavailableError` and 1,628 `EquityWorkerTimeoutError`
in the first three minutes and about 160 failures a minute after that. The
previous process ran five hours with 38 timeouts and never failed.

## Why

Nothing was wrong with the worker. `server/src/engine/equity/EquityWorkerPool.ts`
sizes itself to `availableParallelism() - 2`, which is one worker on a
three-core host, and `enqueue()` armed each job's one 2,500 ms timer at
enqueue. Time a job spent waiting in the queue was charged to the worker.

In the surge the job at the head of the queue reached the worker with a few
milliseconds left and timed out while it was running. `onJobTimeout` read that
as a wedged worker: it terminated the healthy, busy worker and scheduled a
respawn. The replacement took the next aged job from the head of the same queue
and timed out the same way. Ten respawns without one completion spent the
respawn budget, which only a completion refills, and `scheduleRespawn` wrote
`'failed'`. Nothing in the pool ever spawned a worker again, so equity and
insurance were gone until the next restart.

## The fix

Fail-closed is unchanged. An operation that cannot be answered in time is
still rejected, and the event loop still never computes it itself.

- **Two budgets, each measured where it means something.** The queue budget is
  `jobTimeoutMs` from enqueue: a job no worker started in time is removed from
  the queue and rejected with `EquityWorkerTimeoutError` (`stage: 'queue'`). It
  touches no worker, spends no respawn budget, and is counted in
  `status().queueExpirations`. The execution budget is `jobTimeoutMs` from
  dispatch (`postMessage`), and it is the only deadline that retires a worker.
  It gets one event-loop poll turn of grace, the same as the live horse
  client's, so an answer that arrived while the main thread was stalled is
  read before the worker is condemned. A caller waits at most two budgets, in
  practice its queue wait plus milliseconds of compute. Insurance still goes
  ahead of cosmetic equity in the queue.
- **A spent budget starts a cooldown.** With no workers left the pool reports
  `'failed'`, refuses new work at once and fails what is queued. With some
  left it stays `'degraded'` and they keep serving. After 30 s it refills the
  budget and spawns back to size. The cooldown doubles up to 5 minutes while
  recoveries end without a completion, and the first completion resets it.
- **A replacement must say READY.** `ready()` bounds the first boot. A respawned
  or recovered worker now has its own `readyTimeoutMs` deadline, so a boot that
  hangs is retired and retried instead of holding its slot and the recovery
  forever.
- **Nothing outlives `shutdown()`.** It cancels a pending recovery, pending
  respawns and replacement READY deadlines. Every new timer is unref'd.

`status()` keeps every field it had and adds `queueExpirations`,
`executionTimeouts`, `respawnBudgetRemaining`, `nextRecoveryAt` and
`recoveries`. `/health` carries them under `equityWorkerPool`. Every
`EquityWorkerTimeoutError` message keeps the old prefix
(`Equity worker operation timed out after <n>ms`) and adds which budget ran out.

## What it does not change

- The phases and their meaning. `/health` still reads only `phase === 'ready'`,
  so a cooling-down pool answers 503 the way a failed one did. Now that lasts
  as long as the cooldown instead of for the rest of the process.
- The pool size, the 2,500 ms budget, the respawn budget of 10 and the
  insurance-first ordering.
- The live horse decision client. It already separates its action deadline
  (from enqueue) from its worker deadline (from dispatch) since #4190. The 1,718
  `expired before worker dispatch` lines in the same surge were that client
  shedding correctly, and it recovered.

## Damage

None to settle. Every failure was fail-closed: percentages were left off the
felt and insurance was not offered. No price was computed wrong and no contract
was written. The running process stays `'failed'` until it restarts; deploying
this is that restart, and the last one this defect needs.

## Pinned

`server/src/engine/equity/EquityWorkerPool.test.ts`, ten new tests: nine on a
scripted fake worker, one on a real worker thread. All ten fail against the old
pool, seven of them on behaviour rather than on the new status fields:

- a burst whose queued jobs expire leaves the worker untouched and the budget
  unspent. Old pool: the fourth job, dispatched with 10 ms of its budget left,
  was killed along with its worker.
- three seconds of work arriving at three times the worker's capacity, with
  production's budget of 10, ends `'ready'` on the original worker. Old pool:
  `'failed'`, no workers - the incident in miniature.
- a spent pool comes back after its cooldown and serves again. Old pool: no
  worker ever spawns again.
- an answer that arrived while the main thread was stalled past the execution
  budget is accepted. Old pool: the job is rejected and the worker killed.
- a replacement that never says READY is retired, and recovery then succeeds.
  Old pool: the hung replacement holds its slot forever.
- `shutdown()` during a cooldown, a pending respawn or a replacement boot leaves
  no timer armed.

The old execution-timeout test in `EquityWorkerOnly.test.ts` now advances one
extra fake millisecond for the grace turn.
