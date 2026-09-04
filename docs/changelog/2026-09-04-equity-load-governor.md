# 2026-09-04 - The engine's two "error loops" were one saturated core; the horses now yield

## What the Sentry budget named (Club Arena #2970)

After the SDK event budget went live it dropped 1,400-3,750 events per ten
minutes and listed them:

    743 x TournamentBrainContext.refresh | tournament context refresh timed out
    474 x Tournament.elimination_sweep_overrunning | elimination sweep still running after #s

Both read like database problems. Neither was.

## What it actually was

- Postgres answers the refresh's three queries in **0.5 ms** (EXPLAIN ANALYZE
  on production); pg_stat_statements shows a **2 s worst case** across 79,350
  calls. The 5-second deadline was not firing because the query was slow.
- The sweep's statements are milliseconds. The 60-second lock warning was not
  firing because a statement was slow.
- Both fired in the SAME minutes (journal, 16:26-16:40, 16:51-17:00,
  17:33-17:36), and `poker_discovery_loop_stalled_ms` peaked at **72,774 ms**
  in that hour.
- `docker stats`: the engine container at **100% of one core**. Node is
  single-threaded.
- A 12-second CPU profile of the live process (inspector over SIGUSR1):

      54.4%  scoreHoldem            engine/HorseEval
      18.1%  scoreOmahaHi           engine/HorseEval
       6.1%  simulateEquity         engine/HorseEval
       4.6%  placeOmahaBandCombo    engine/HorseEval
       3.2%  scoreOmahaLow          engine/HorseEval
       1.6%  (garbage collector)
       0.3%  (idle)

Nine-tenths of the main thread was horse Monte Carlo. Each decision is inside
its own 11-13 ms budget; ~90 tables dealing 1.5 hands a second is what pegs
the core. When the event loop is that saturated every timer and every await in
the process is late: the refresh deadline, the sweep lock, discovery, and -
the part that matters - every HUMAN's action, turn timer and broadcast.
Hands per minute fell from 96 to 65 during the 17:33 burst.

## The fix: `server/src/engine/EquityLoadGovernor.ts`

One choke point, `simulateEquity()`, now asks a governor for a scale before it
samples. The governor reads `perf_hooks.monitorEventLoopDelay` once a second:

    p50 loop delay   Monte Carlo scale
    < 40 ms          1.00
    < 120 ms         0.60
    < 300 ms         0.35
    otherwise        0.20   (floor 60 iterations so the adaptive exit still has checkpoints)

It logs once a minute while throttled and once on recovery, and `/health`
carries `equityGovernor: { enabled, scale, p50Ms, p99Ms, throttledForS }`.
`EQUITY_GOVERNOR=off` disables it; `vitest.config.ts` sets that so a busy test
runner cannot shrink the samples the precision tests depend on.

HORSES ARE PLAYERS (CLAUDE.md 10.5) is untouched: same timers, same pauses,
same rules, same seat. Under load a horse reads its equity from a smaller
sample - a noisier read of the same hand, not a different deal - and the
alternative, every seat waiting on the horse's arithmetic, is worse for the
horse too.

## Tests

`server/src/engine/EquityLoadGovernor.test.ts`: the scale table (including the
measured 72,774 ms stall), the floor, that a throttled read of aces heads-up
is within 8 points of the full read, that the throttled call is measurably
cheaper, and the health snapshot. The 41 Horse\* suites (509 tests) still pass.

## What this does NOT do, and what is next if the core is still hot

The governor trades precision for latency; it does not make evaluation
cheaper. If `/health` shows the scale below 1 for long stretches at normal
load, the next levers, in order of payoff:

1. Move `simulateEquity` to a worker pool (the box has 3 cores; the engine
   uses one). Needs the horse decision path to become async at
   `scheduleHorseAction`.
2. A perfect-hash 7-card evaluator for `scoreHoldem` (54% of the profile).
   Differential-test it against the current evaluator on millions of hands
   before switching.
3. Memoise equity per (hero cards, board, opponents, bands) within a street;
   a horse facing a re-raise recomputes the same read.

Do not raise `REFRESH_TIMEOUT_MS` or `ELIMINATION_SWEEP_STUCK_MS` to quiet the
reports; they were telling the truth about the loop.
