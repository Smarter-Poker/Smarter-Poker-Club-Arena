# An empty histogram is not an idle loop

**2026-09-07** — branch `fix/an-empty-histogram-is-not-an-idle-loop`

The open item from `2026-09-07-the-collapse-was-not-the-reload-storm.md`, and
the reason that outage lasted twenty minutes with nothing shedding load. The
guard was on, and it was reading a constant.

## The number that gave it away

Through the 04:05 collapse — one core pegged at 100.8%, two cores idle,
Postgres answering the "timed out" query in 133 ms — `/health` said:

```json
"equityGovernor": { "enabled": true, "scale": 1, "p50Ms": 0.000511, "p99Ms": 0.000511 }
```

p50 **equal to** p99, to six decimal places, and **identical across two separate
engine processes twenty minutes apart**. That is not a measurement. Proved
against Node directly:

```
h.reset();
h.percentile(50)/1e6 -> 0.000511    h.percentile(99)/1e6 -> 0.000511    h.count -> 0
```

**`0.000511` is what `IntervalHistogram.percentile()` returns when nothing has
been recorded.** `sample()` fed it straight to `scaleForLoopDelay`, which read
half a microsecond as enormous headroom and returned scale 1.

## Why that is a trap and not a rounding error

`monitorEventLoopDelay` only records when the loop **turns**. A loop pegged by
one long synchronous run does not turn, so it collects **fewer samples the more
saturated it is** — at the limit, none.

So the emptier the histogram, the more load there is, and the governor was
reading empty as idle. **It stood down precisely when it was needed.** A guard
that inverts under its own trigger condition is worse than no guard, because
everyone downstream believes it.

## Two changes, both about refusing to guess

**1. An empty reading is UNKNOWN, never fast.** `count === 0` no longer
produces a reading; the previous scale is **held** rather than snapped back to
1, and the snapshot carries `stale: true` so `/health` and `/metrics` cannot
show a confident number nobody measured. `count` is the authority; a
belt-and-braces check also rejects two percentiles identical to the nanosecond
at a value far below the histogram's own 20 ms resolution.

**2. The sampler measures its own lateness, which cannot go blind.** A
one-second interval that fires at 1,800 ms has measured 800 ms of loop
saturation _directly_ — no dependence on the loop turning often enough to be
sampled. The scale is decided on the **worse** of the two readings, so the
histogram still wins when it is working and lateness carries it when the
histogram has nothing. An early tick is clamped to zero: that is no news, not
negative headroom.

Neither touches the scale table or the iteration floor. This changes what the
governor can **see**, not what it decides once it can see it.

## Proved against a real pegged loop

A 2.5-second synchronous block, with the governor running exactly as it does in
the engine:

```
min scale observed      = 0.2
worst sampler lateness  = 1700 ms
OLD behaviour on the same block: scaleForLoopDelay(21ms histogram p50) = 1
PASS: a 2.5s block now sheds load
```

The old code scored that block at **21 ms and did nothing**. The engine's own
log during the run:

```
[EquityGovernor] event loop p50 21ms p99 2512ms - horse Monte Carlo scaled to 20%
[EquityGovernor] loop recovered (p50 21ms) after 1s throttled
```

It sheds and it recovers.

## The reading now leaves the process

`poker_equity_governor_sampler_late_ms`, on the always-on registry beside the
three gauges that can go blind. Read together:

| p50 gauge | sampler-late gauge     | what it means                                    |
| --------- | ---------------------- | ------------------------------------------------ |
| rising    | rising                 | ordinary saturation, both agree                  |
| flat/tiny | rising                 | the histogram is being starved — the 04:05 shape |
| flat      | flat, while hands stop | not the loop; escalate elsewhere                 |

Before today the second row was indistinguishable from a healthy engine.

## HORSES ARE PLAYERS is untouched (10.5)

Same timers, same pauses, same rules. Under load a horse reads its equity from
a smaller Monte Carlo sample — a noisier read of the same hand, not a different
deal — and the alternative is the whole table waiting on the horse's
arithmetic, which is worse for every seat including the horse's own. That
trade-off is unchanged; all that changed is that the governor can now tell when
to make it.

## What this does NOT fix

The elimination sweep is still the thing filling that core — 780
"elimination sweep still running" in fifteen minutes, tournaments not
completing, the RUNNING set accumulating. The governor can now **see** the
saturation and shed horse precision to buy headroom, which is a real mitigation
and not a cure. Profiling the sweep against a live 120-tournament set, and
moving it off the single thread that also serves every human's action, remains
the engine-restart programme's work.

## Files

- `server/src/engine/EquityLoadGovernor.ts` — `isEmptyReading`,
  `effectiveDelayMs`, sampler lateness, `stale` in the snapshot
- `server/src/engine/theGovernorGoesBlindWhenItMattersMost.test.ts` (new, 19 cases)
- `server/src/observability/engineInstruments.ts`, `server/src/GameServer.ts` —
  the gauge and its scrape
