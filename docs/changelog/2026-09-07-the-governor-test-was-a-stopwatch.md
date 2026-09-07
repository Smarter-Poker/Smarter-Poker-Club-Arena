# The governor test was a stopwatch, and the stopwatch was the bug

**2026-09-07** — branch `fix/the-governor-test-is-a-stopwatch`

`EquityLoadGovernor.test.ts > is measurably cheaper when throttled` failed the
whole `Server Engine (typecheck + tests)` job on a branch that had not touched
the governor, blocking a pull request for an hour. It is one of the flakes
behind `Full server test suite` showing up on four unrelated open branches at
once.

## What it asserted, and why it could not hold

```ts
const fastest = (scale) => Math.min(time(scale), time(scale), time(scale));
expect(throttled).toBeLessThan(full * 0.6);
```

Measured on the runner: `throttled = 98.6 ms`, `full = 142.3 ms` — a ratio of
**0.69** against a threshold of 0.6.

The governor did its job. 450 iterations became 90, a fivefold cut in sampling
work, and the wall-clock only moved by 31% because **per-call fixed cost
dominates a 90-iteration sample**: deck construction, the known-card set,
allocation, the return path. That fraction is not a property of the code, it is
a property of the box — and the box is a 16-core runner shared by up to twelve
jobs.

**Best-of-three and a warm-up pass had already been added, and did not save
it.** That is 10.86 rule 4 exactly: the de-flake was correct, and it left the
same trap one level up, because the thing being measured was never
milliseconds.

## What it asserts now

`simulateEquity` records the sample it was actually granted — after the scale,
the floor, and the banded-Omaha trim — and `equitySampleSizeOfLastCall()`
returns it:

```ts
expect(sampleAt(1)).toBe(450);
expect(sampleAt(0.6)).toBe(270);
expect(sampleAt(0.2)).toBe(90);
```

Integers, at any load. A governor that stops being consulted makes all three
450 and fails this on the first run; the old test needed a quiet runner to
notice the same thing. A second case pins the floor from the caller's side:
`220 * 0.2 = 44`, and a horse that samples 44 hands is not playing poker, so it
must come back as 60.

The suite went from 1.5 seconds of deliberate CPU burning to **12 ms**.

## The number is worth having anyway

`/health.equityGovernor.scale` says what the governor DECIDED.
`equitySampleSizeOfLastCall()` says what the one function that spends the core
actually got. During the 04:05 collapse the governor reported `scale: 1` while
one core sat pegged at 100.8% — the case for being able to read the decision
and the spend separately, rather than inferring one from the other.

## Files

- `server/src/engine/HorseEval.ts` — records the granted sample, one getter
- `server/src/engine/EquityLoadGovernor.test.ts` — the stopwatch replaced, and
  the floor pinned from the caller's side
