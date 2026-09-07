# What is actually on the core

**2026-09-07** — branch `fix/what-is-actually-on-the-core`

The last thing standing between the engine-thread outage and a fix for it: the
cause has no numbers. This gives it three.

## Why this, and not the fix itself

The 04:05 outage — fleet from ~480 hands a minute to **6** for twenty minutes,
container at **100.8% CPU** (one core, pegged) with two of the box's three
cores idle, Postgres answering the "timed out" query in **133 ms** — was caused
by the tournament elimination sweep.

The only way to establish that was to SSH to the box and run:

```
docker logs club-arena-engine | grep -c "elimination sweep still running"
780
```

Fifteen minutes, from a warning that fires **once per stuck episode** — so ~780
distinct stuck sweeps. **A number you can only get by grepping a container is a
number nobody watches**, and it is why a twenty-minute outage was diagnosed by
hand rather than by a chart.

`startEliminationChecker` opens a `setInterval` **per tournament** at
`ELIMINATION_SWEEP_MS` (5,000 ms). At the 120–199 RUNNING tournaments measured
that night, that is **24–40 sweeps a second on one JavaScript thread**. And it
feeds itself: a sweep that overruns stops its tournament completing, so the
RUNNING set grows and the next second carries more sweeps than the last.

The fix has to choose between two very different things:

- **one sweep is slow** → optimise the sweep, and
- **thirty cheap sweeps are simply too many** → re-schedule them.

Nothing on this platform could tell those apart. That is what these three
series are for. They are the prerequisite, not a substitute — the cause stays
P0/P1 in `docs/HANDOFF_CURRENT_STATE.md` section 16.

## The three

| series                                              | what it answers                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `poker_tournament_elimination_sweep_ms`             | how long **one** sweep takes, as a distribution                                                                             |
| `poker_tournament_elimination_sweeps_inflight`      | how many run **at once** — the concurrency the single thread is actually carrying                                           |
| `poker_tournament_elimination_sweep_overruns_total` | the 780, as a series instead of a grep — labelled `outcome=warned` (late) and `outcome=forced` (abandoned, lock taken back) |

All three on the **always-on** registry. An outage metric behind a feature flag
is a metric that is off during the outage.

## The three ways a gauge like this drifts, all closed

1. **The forced sweep never reaches its own `finally`.** Its generation is
   superseded, so the release is skipped by design — and without an explicit
   decrement where the lock is forced, the inflight gauge climbs for ever on
   exactly the process that is in trouble. Released there.
2. **Only the current holder decrements.** Decrementing twice for one sweep
   walks the gauge negative, and a metric that lies about the _direction_ of
   load is worse than no metric.
3. **The start time is taken inside the tick**, not read from
   `eliminationSweepStartedAt` — that field is zeroed by whoever releases the
   lock, so reading it in the `finally` would record 0 ms for every superseded
   sweep, which are precisely the slow ones.

The duration is observed in the `finally`, not on the happy path: a sweep that
threw is the one whose duration matters most.

Ten cases pin all of it in
`server/src/tournament/theSweepOnTheCoreIsANumber.test.ts`, including that the
cadence is still one interval per tournament — the thing the data now has to
justify changing.

## What to look for when it fires again

- `_inflight` climbing while `_ms` stays flat → **too many sweeps**, not slow
  ones. Re-schedule: one shared pass over all tournaments instead of N timers.
- `_ms` climbing with `_inflight` flat → **one sweep got expensive**. Profile
  it; the last two rounds of work on this file (2026-08-25 dedupe, 2026-08-28
  one paged read instead of one per table) were both this shape.
- `_overruns{outcome="forced"}` rising at all → tournaments are being abandoned
  mid-sweep, which is where `fn_ca_tournament_finished_but_not_completed` (the
  detector added earlier today) starts finding unpaid winners.

Read beside `poker_equity_governor_sampler_late_ms`: loop saturation on one
axis, what is filling the loop on the other. Until today the platform had
neither.

## Files

- `server/src/observability/engineInstruments.ts` — the three series
- `server/src/tournament/TournamentManagerEliminations.ts` — the wiring
- `server/src/tournament/theSweepOnTheCoreIsANumber.test.ts` (new, 10 cases)
