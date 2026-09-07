# The governor was reading a histogram it had just reset

2026-09-07, found while verifying that yesterday's new engine-core metric was
live. It was not. `/health` and `/metrics` were publishing this, on an engine
with 137 hands in flight:

```
poker_event_loop_delay_p50_ms 0.000511
poker_event_loop_delay_p99_ms 0.000511
poker_equity_governor_scale 1
```

Frozen to the digit across three reads six seconds apart while the hand count
moved. p50 and p99 identical is the first tell; 0.000511 ms is 511 nanoseconds,
and an event loop does not answer in half-microseconds.

## What 511 is

```
$ node -e "const {monitorEventLoopDelay}=require('node:perf_hooks');
           const h=monitorEventLoopDelay({resolution:20});
           console.log(h.percentile(50), h.percentile(99), h.count)"
511 511 0
```

511 is what Node answers for `percentile()` on a histogram holding **zero
samples**. Divided by 1e6 it becomes 0.000511 ms, which reads as a perfectly
idle loop and is in fact the absence of a measurement. For comparison, an idle
process with a real reading answers about 21,000,000 ns - the 20 ms resolution
plus jitter.

## Why it was empty

Two callers, one histogram, one of them unguarded.

```ts
sample(now) {                      // the boot timer, every 1000ms, unguarded
  this.sampledAt = now;
  this.p50Ms = this.histogram.percentile(50) / 1e6;
  this.p99Ms = this.histogram.percentile(99) / 1e6;
  this.histogram.reset();
  ...
}
current(now) {                     // the horse equity path, thousands/second
  if (now - this.sampledAt < SAMPLE_EVERY_MS) return this.scale;
  return this.sample(now);
}
```

`current()` held the elapsed-time check. `sample()` held none, and the timer
called it directly. Both run on a one-second cadence, so they drift into phase,
and once they land inside the same 20 ms window the second one reads a
histogram the first emptied a millisecond earlier - and its 511 is what gets
published. Reproduced exactly, with a timer and a hot `current()` loop:

```
published p50Ms 20.414463 p99Ms 21.561343
published p50Ms 20.479999 p99Ms 21.381119
published p50Ms 20.414463 p99Ms 21.135359
published p50Ms 20.430847 p99Ms 21.364735
published p50Ms 0.000511  p99Ms 0.000511      <- the two landed together
published p50Ms 20.430847 p99Ms 21.544959
```

In the test harness it happened once in six seconds. In production the two
cadences had phase-locked, so it was every reading.

## Why it mattered

Not cosmetically. `scaleForLoopDelay(0.000511)` is 1, so:

- **the EquityLoadGovernor never shed load.** The engine is one Node core and
  horse Monte Carlo was profiled at 90% of it; the governor scaling the sample
  is what keeps a saturated loop from eating every timer, sweep and refresh.
  It had been pinned at full precision no matter how hot the core got.
- **both engine-core alerts became unfireable.** `EngineCoreOutOfHeadroom`
  (p50 > 40 ms for 10m) and `EngineCoreSaturated` (p50 > 300 ms for 5m) cannot
  trigger on a series that is always 0.0005.

The metric reaching zero meant the opposite of success - the exact trap
`docs/HANDOFF_CURRENT_STATE.md` warns about, arriving from a new direction.

## The fix

One authority decides when a reading exists, and it is the method that does the
reset. The elapsed-time check moves into `sample()`; `current()` is now just
`return this.sample(now)`, so there is no second copy of the rule for a direct
caller to walk past.

Beside it, the assertion that the published number IS a measurement:

```ts
if (this.sampledAt !== 0 && now - this.sampledAt < SAMPLE_EVERY_MS) return this.scale;
if (this.histogram.count === 0) return this.scale;
```

The second line is belt and braces - with the first in place it should never
fire - but it is what makes the class honest for any future caller, on any
cadence. An empty histogram is not a fast loop. It is no reading at all, and
"I could not tell" must never be published as a number (10.86 rule 1).

The same harness, with the guard in place, eight consecutive seconds:

```
published p50Ms 20.611071 p99Ms 20.611071
published p50Ms 20.545535 p99Ms 23.511039
published p50Ms 20.430847 p99Ms 21.413887
published p50Ms 20.430847 p99Ms 21.905407
published p50Ms 20.430847 p99Ms 21.200895
published p50Ms 20.447231 p99Ms 21.381119
published p50Ms 20.447231 p99Ms 21.282815
published p50Ms 20.447231 p99Ms 21.200895
```

## The lesson, which is not the one I expected

Yesterday's fix was correct and it caused this. The governor used to sample only
inside `current()`, so the loop was read when a horse happened to be thinking
and at no other time; adding a clock was right. What it did not do was retire
the old rule from where it lived. Two samplers, one guard, and the guard was on
the wrong one.

10.86 rule 4: a fix that leaves the same trap one level up has not landed. When
you add a second caller to something stateful, the question is not whether the
new caller is correct - it is whether the rule that protected the old one still
covers both.

## Files

- `server/src/engine/EquityLoadGovernor.ts`
- `server/src/engine/theCoreThatLimitsEverythingIsANumber.test.ts` - three new
  cases: the reset window, the empty-histogram sentinel, and one authority for
  when a reading exists. The first two need a governor that is really watching
  the loop, so they stub `EQUITY_GOVERNOR=on` and import a fresh module; the
  server suite runs with it off.
