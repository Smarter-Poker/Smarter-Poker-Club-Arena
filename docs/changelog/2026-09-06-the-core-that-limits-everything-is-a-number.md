# The core that limits everything is a number (2026-09-06)

## How this was found

Chasing a cluster pass that `/health` reported as **28,426 ms** against a
five-second cadence. Six measurements later the answer was that there is no
problem: steady state is p50 **0.86 s**, p95 **1.9 s**, and the 28 s sample
was the minutes after an engine restart while 195 tables were adopted. The
SQL half was never the cause either - measured over a live window,
`fn_cash_clusters_tick_all` averages **619 ms**.

What the chase exposed is the real defect: **nothing in this platform
measures the one core it all runs on**, so every latency question has to be
answered by elimination, and the first four guesses are wrong.

## Two reasons the ceiling was unmeasurable

**1. The governor sampled on a horse's turn, not on a clock.**
`EquityLoadGovernor`'s docblock says "It samples the event-loop delay once a
second". It did not. `current()` was the only sampler and `current()` is
called from `simulateEquity`, so the loop was measured when a horse happened
to be computing equity and at no other time. A quiet minute left the reading
a minute stale, and a loop saturated by anything that is not horse arithmetic

- settlement, broadcasts, logging, a boot adopting 195 tables - was never
  sampled at all. That is exactly when the governor is supposed to shed load.

Measured on production while writing this: `/health` reported
`equityGovernor.p50Ms 0.000511` on a container at **104% CPU**. Not wrong -
just a reading taken at an idle instant and held.

**2. The reading never left the process.** It existed only inside
`equityGovernor.snapshot()` in the `/health` JSON. No series, no chart, no
alert, nothing to correlate a slow pass or a laggy table against.
`HorseDataLedger.ts` states the gap in its own words: _"the ONLY visibility
the governor has outside the GameServer status payload"_. Meanwhile
`eventLoopLag` is declared in the ENGINE_METRICS-gated registry and **nothing
has ever observed it** - a metric that is off in production and empty if you
turn it on, which is the shape CLAUDE.md 10.84 and 10.86 are about.

## What changed

- `EquityLoadGovernor` owns an **unref'd one-second sampler**
  (`startSampling` / `stopSampling`), started at boot and stopped with the
  server. `current()` still samples on demand when no timer runs, so tests
  and any process that never starts it behave exactly as before. **The scale
  table is untouched** - this changes when the delay is read, not what the
  governor decides from it. A reading it cannot take is caught and the next
  one is still attempted (10.86).
- Three gauges on the **always-on** registry, rendered on every scrape:
  `poker_event_loop_delay_p50_ms`, `poker_event_loop_delay_p99_ms`, and
  `poker_equity_governor_scale`. The scale is published beside the delay
  deliberately: a high p50 with a scale of 1 means the governor is not
  reacting, and a low p50 with a scale below 1 means it is throttling on a
  reading nobody can see. Together they check each other; apart, either can
  lie.
- Three alerts in a new `engine-core` group, **all three break-guarded**
  (CLAUDE.md 13 rule 6) so the hourly :55 cutover cannot ring them.

## The thresholds are derived, not guessed (10.84)

They are the governor's own table, which is the platform's existing statement
about what its core can take:

| p50 loop delay | governor scale        | alert                                       |
| -------------- | --------------------- | ------------------------------------------- |
| < 40 ms        | 1.00 (full precision) | -                                           |
| >= 40 ms       | 0.60                  | `EngineCoreOutOfHeadroom`, warning, for 10m |
| >= 120 ms      | 0.35                  | -                                           |
| >= 300 ms      | 0.20 (floor)          | `EngineCoreSaturated`, critical, for 5m     |

`EngineSheddingPrecisionForHours` fires when the scale has been below 1 for
two hours: not a fault, but the only signal that says the room is trading
decision precision for latency right now. The `for:` windows are longer than
the post-restart transient measured today (p95 26.8 s in the minutes after a
cutover, 1.9 s at steady state), so a scheduled restart cannot raise any of
them.

## What this does NOT claim to fix

The core is still one core, and 195 tables and 160 tournaments still share
it. This does not make that faster. It makes it **visible**, which is the
difference between "the database is slow" and "the loop is late", and today
that difference cost six measurements to establish by hand. Per CLAUDE.md
10.11 this is not a fix for saturation - it is the fix for a platform that
could not tell you it was saturated.

## What to watch first

`poker_event_loop_delay_p50_ms` across a :55 cutover. The expected shape is a
spike while the fleet is adopted and a return under 40 ms within a few
minutes. If it does not return, the boot itself is the load, and the next
question is what the engine does in its first two minutes that it does not
do afterwards.
