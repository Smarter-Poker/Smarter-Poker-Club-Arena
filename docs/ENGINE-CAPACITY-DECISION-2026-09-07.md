# Engine capacity: the ceiling, the three ways past it, and what it costs

**2026-09-07.** Written after profiling the live engine during and after the
04:05 UTC throughput collapse. This is a decision document, not a plan of
record: the option that fixes it properly is one the `server/src/scale/README.md`
already says is the platform owner's call, and it is Dan's to make.

---

## The measurement

A 20-second CPU profile of the running container, taken through the V8
inspector while the fleet dealt normally:

```
34.15%  scoreHoldem          HorseEval
12.38%  scoreOmahaHi         HorseEval
 5.41%  (garbage collector)
 4.15%  simulateEquity       HorseEval
 4.07%  (idle)
 3.59%  placeOmahaBandCombo  HorseEval
 2.98%  evaluate5Cards       PokerEngine
 1.94%  cardId               HorseEval
```

**62% of the main thread is horse hand evaluation. 4% is idle.**

Alongside it, from `/health` and `docker stats`:

|                 |                                                     |
| --------------- | --------------------------------------------------- |
| box             | 3 cores, load average 1.47                          |
| container       | 142% CPU — one thread pegged, plus GC and libuv     |
| event-loop p50  | 1,660 ms at the worst; 189 ms in a calm hour        |
| equity governor | pinned at its 0.2 floor for 335 consecutive seconds |
| idle cores      | roughly one and a half, continuously                |

The engine is single-threaded for game logic. It cannot use the other two
cores, so the platform's ceiling is one core's worth of horse arithmetic —
about 500 hands a minute across ~300 tables, and that is the number that broke.

## What that ceiling actually costs players

At p50 1,660 ms every timer in the process runs late:

- `table-socket-probe` logged `handshake_timeout` on 8 of 11 runs in the 04:00
  hour, against a 15-second budget;
- one log window held 1,160 `FORCED state: timer_running -> waiting` against
  299 hands;
- `poker_avg_hand_duration_ms` read 25,000-58,000 where ~7,000 is normal.

A pegged core is a laggy table for everyone at it, human and horse alike.

## What has already been done (shipped 2026-09-07)

1. **The governor can see again.** An empty `monitorEventLoopDelay` histogram
   returns 0.000511 ms, which `scaleForLoopDelay` read as enormous headroom —
   and the histogram only records when the loop TURNS, so it collected fewer
   samples the more saturated the loop was. It stood down precisely when
   needed. (Fixed earlier the same day, separate work.)
2. **The governor has travel again.** Its bottom tier was 0.2 with a floor of
   60 iterations, tuned for "~90 tables dealing 1.5 hands a second" — roughly a
   fifth of today's load. Added a deep tier at 0.08 with a floor of 30, and
   stopped the banded-Omaha floor raising the sample back to 120 _after_ the
   governor had already spoken.
3. **The fleet can now be seen at all.** `/metrics` emitted fourteen unlabelled
   global gauges once per table engine, so Prometheus kept one arbitrary sample
   of 272 and answered `poker_active_tables 1`. Fixed; verified live at 276.

Those buy headroom and visibility. **None of them adds capacity.** Shedding
Monte Carlo precision is a brake.

## The three ways past the ceiling

### Option A — worker-thread pool for equity

Move `simulateEquity` off the main thread into a pool like the one that already
exists at `server/src/engine/equity/EquityWorkerPool.ts` (used for all-in and
insurance equity: job queue, watchdog, respawn budget, synchronous fallback,
`EQUITY_WORKERS=off` kill switch — a proven template).

**Every argument is already structured-cloneable.** `Card`, `VariantInfo`,
`oppBands` and `oppReads` are plain data. Serialisation is not the problem.

**The problem is that the horse brain is built on the decision being atomic.**
Three separate comments state it as load-bearing:

- `HorseEval.ts:1950` — _"Module state, like the RNG: decisions are synchronous
  and never interleave."_
- `HorseMind.ts:910` — _"the callback is SYNCHRONOUS by contract … nothing else
  in the process can observe the swapped state."_
- `HorseEval.ts:72` — `saveFastRandom`/`restoreFastRandom` exist because the
  league silently rewinding the global stream was a real, shipped bug.

One `await` inside `decide()` makes all three false at once: two horses at two
tables interleave and each observes the other's `decisionScope`, `equityDepth`
and RNG position.

**Cost.** Five synchronous frames to unwind (`simulateEquity` →
`decidePostflop` → `decideInternal` → `HorseLogic.decide` →
`scheduleHorseAction`), plus ~40 test files that call `HorseLogic.decide`
synchronously, plus re-baselining every pinned equity value — including the
exact-equality assertion at `HorseV44SecondLook.test.ts:109`. The RNG must
become an explicit per-call seed, which changes the draw sequence and therefore
every seeded behavioural test.

**Verdict: a multi-day programme with real gameplay risk. Not a session's work,
and not something to rush on a platform handling money.**

### Option B — shard tables across threads

`server/src/scale/ShardManager.ts` already exists and, per its README, works.
Each shard is its own thread with its own `rngState`, its own scratch buffers
and its own governor, so **all three obstacles vanish by construction and
`decide()` stays synchronous.**

It is not wired into `index.ts` or `GameServer.ts` — deliberately. Its README
says so directly, under "Infra decisions the platform owner must make":

> ship **single-node + `worker_threads`** first (zero new infra, immediate
> multi-core throughput, and it already unlocks zero-downtime deploys via drain
> within the box)

**Verdict: architecturally the right answer, already built, and explicitly
Dan's call to enable. Recommended, with a staged rollout — a small shard count
first, watching `poker_event_loop_delay_p50_ms` per shard.**

### Option C — make the arithmetic cheaper

Two levers, both already named in
`docs/changelog/2026-09-04-equity-load-governor.md`:

1. **A perfect-hash 7-card evaluator** for `scoreHoldem`. It is 34% of the
   thread on its own; a table-driven evaluator is several times faster. Pure
   function in, pure function out — no async, no RNG change, no interleaving.
   It must be proven exactly equivalent over millions of hands before it can
   ship, because any discrepancy silently changes who wins a pot.
2. **Memoise equity within a street** for an identical (hero, board, opponents,
   bands) read. A horse facing a re-raise recomputes the same spot today.
   Careful: a cache hit consumes no random draws, so this shifts the RNG stream
   the same way Option A does. `preflopEquity` already memoises, so there is
   precedent — but the precedent should be examined rather than assumed.

**Verdict: (1) is the largest safe single win available and is worth doing on
its own merits, whatever is decided about threads. (2) needs the RNG question
answered first.**

## Recommendation

**B, then C1.** Enable sharding at a small count and measure; it needs no
change to the horse brain and its risks are operational rather than semantic.
Then take the perfect-hash evaluator, which reduces the work regardless of how
many threads are doing it. Leave A unless B proves impossible — it buys the
same thing for far more risk.

Whatever is chosen, the alarm that now catches this class is
`EngineFleetThroughputCollapsed` (added the same day, thresholds derived from a
measured week), and the ones that caught it on 2026-09-07 were
`EngineCoreOutOfHeadroom` and `EngineCoreSaturated`. Capacity work should be
judged against `poker_event_loop_delay_p50_ms`, not against hand counts —
hand counts fall for a quiet night too.
