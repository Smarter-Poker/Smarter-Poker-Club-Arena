# Phase 6 items 2, 5, 6, 7 - the wheel agrees with the shared clock

2026-09-01. Branch `phase6/wheel-clock`.

Four defects, one family. Every one is the Spin wheel disagreeing with the
engine's shared clock, or with itself.

This branch is stacked on `phase6/no-dead-felt` and `phase6/wheel-stays-on-its-tile`
because all three touch `SpinWheel`; the merge is already resolved here so the
three land as one lineage rather than as three conflicts.

## Item 2 - the celebration was two thirds invisible

```css
left: calc((var(--sw-c) * 4.16%) + 2%);
animation-delay: calc(var(--sw-c) * 55ms);
```

`4.16%` is 100/24 - a spread hand-tuned for 24 pieces. The tiers emit
**16 / 32 / 48 / 72**, so every piece from index 24 up landed past 101.8% and
was clipped: **a 50x and a 100x rendered identically to a 25x.** The one moment
the format exists for, and the three biggest results looked the same.

The delay had the same shape - piece 71 started at 3.905 s against a 4.8 s hold
and a 1.8 s fall, so the tail fell after the wheel had gone.

Both are now derived from `--sw-c-total`, the actual piece count, with a
fallback of 24 so any older caller behaves exactly as before. The delay spreads
the whole burst across a fixed 900 ms however many pieces there are, which is
what keeps the last piece inside the hold - and a test asserts that arithmetic
rather than trusting it.

## Item 5 - a late arrival got a flicker, then nothing, ever

Every phase is scheduled through `at()` = `max(0, offset - elapsed)`. A client
that mounts after the sequence has elapsed resolves **every** phase to zero:
countdown, chase, result and exit all fire in the same tick. The player got a
four-frame flash - and `onDone` stamps `markSpinRevealPlayed`, so that tab never
showed the draw again.

If the sequence is already past its chase there is nothing left to animate and
the honest thing to show is the answer. It now mounts into `result` and holds
it - and since "no dead felt", at least until the engine deals.

## Item 6 - the Animation Speed setting did nothing

`getAnimationSpeed()` was consulted only on the no-shared-clock branch, which
never happens in production. The setting had no effect on the wheel while the
component's own comment promised the opposite.

It joins the same one-sided clamp: `Math.min(factor, getAnimationSpeed(), 1)`.
A player may run the sequence **faster** than the budget - their wheel lands
early and the felt waits with everyone else - but never slower, because slower
means being dealt into a hand while the wheel is still asking the question.

## Item 7 - two paths, two clocks

The socket path passes `hold_until` as `revealDeadlineMs`. The row-derived
fallback passed nothing, so its speed clamp fell back to `spinRevealTotalMs()`
and it could be out of step with the two seats that DID get the broadcast - the
exact "three players, three wheels" failure the shared clock exists to prevent.

The engine computes the hold as `revealAt + spinRevealToDealMs()`. Deriving it
here from the same spec gives both paths the same number without inventing one.

## Verification

- `npx tsc --noEmit`: clean.
- `tests/the-wheel-agrees-with-the-shared-clock.law.test.ts`: 6 tests, green,
  registered in `docs/LAWS.md`.
- The full client suite runs in CI on this pull request.

Not verifiable from here: how the burst looks. There is no logged-in browser
session available to this agent, so the spread is argued from the arithmetic
(96% across `--sw-c-total`, delay 900 ms + 1.8 s fall inside a 4.8 s hold)
rather than from having watched a 100x land.
