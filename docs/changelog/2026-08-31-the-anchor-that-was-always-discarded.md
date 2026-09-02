# The anchor that was always discarded

2026-08-31, spins audit part 2. Dan: _"go through it all line by line, check
for any bugs, stubs, gaps, errors, regressions or wiring issues."_

This is a regression that shipped **this morning**, inside a fix that was
correct, and that no test could see because every line the tests look for was
still there.

## 1. What broke

The spin reveal is anchored to the third payment so the wheel is not charged
for the engine's start-up work:

```ts
this.spinRevealAt = anchor + SPIN_REVEAL.LEAD_IN_MS; // the wheel is due here
this.spinHoldUntil = anchor + spinRevealToDealMs(); // the deal waits here
```

The client honours that anchor exactly — `elapsed = max(0, now - revealAt)`,
and every beat behind `elapsed` fires at once — so there is exactly one
condition under which the anchor must be abandoned: **the reveal instant has
already passed**. `resolveSpinReveal` asked it like this:

```ts
if (this.spinHoldUntil - now < spinRevealToDealMs()) {
  /* re-anchor */
}
```

While the hold was stamped as `spinRevealAt + toDeal` — that is,
`anchor + LEAD_IN + toDeal` — that expands to `anchor + LEAD_IN < now`, which
is the right question.

Earlier the same morning the double-counted lead-in was removed and the hold
became `anchor + toDeal`. **That change was right on its own terms** — the deal
had been held a full second longer than the sequence it waits for, a second of
dead air on every spin. But the threshold was expressed in terms of the hold,
so it moved with it:

```
anchor + toDeal - now < toDeal   ⟺   anchor < now
```

`anchor` is the third payment and `now` is after the draw, so that is **true
for every spin that has ever run**.

## 2. What it cost

- **The anchor was discarded 100% of the time.** The wheel no longer opened one
  second after the third payment even when the engine was quick — which is the
  entire promise `stampSpinRevealAnchor` exists to keep, and Dan's rule
  verbatim: _"THE MOMENT THE 3RD SEAT IS BOUGHT AND PAID FOR THE SPIN
  ANIMATION MUST START 1 SECOND LATER."_
- **`Tournament.spin_reveal_window_overrun` was reported on every spin** —
  roughly 1,500 a day at current volume. An alert that fires every time is how
  a real lateness signal gets buried.

Nothing failed. No test went red. The behaviour stayed _safe_ — a re-anchored
wheel still plays in full — so the only symptom was a promise quietly no
longer kept.

## 3. The fix

The question is now asked where it belongs, in terms of the instant the client
actually keys on:

```ts
const wouldSkipABeat = spinRevealWouldSkipABeat({ now, revealAt: this.spinRevealAt });
if (wouldSkipABeat) {
  /* re-anchor and report */
}
```

`server/src/tournament/spinRevealWindow.ts` is a pure module — no clock, no
instance, no I/O — so `spinRevealWindow.test.ts` can **execute** the decision
on real numbers instead of reading the source for a string. It pins:

- a draw landing 400ms after the third payment keeps the anchor;
- landing exactly ON the reveal instant keeps it (elapsed is 0, nothing is
  skipped);
- one millisecond past it re-anchors;
- **and the old hold-based form, evaluated on the same inputs, says
  "re-anchor" where the correct one says "keep"** — the regression itself,
  pinned as arithmetic so it cannot come back.

It also proves the safety property the re-anchor was protecting: when the
anchor is kept the hold is `anchor + toDeal`, which is earlier in wall-clock
terms than `now + toDeal`, and the test shows it still covers every beat the
player has not yet seen. The two are exactly equal — the deal is never brought
forward onto the wheel.

Three existing tests anchored on the old string and were corrected in the same
commit, with a note saying why they passed throughout the broken window.

## 4. The gap underneath it — nothing was measuring the wheel

`spinRevealLagMs` is computed on every spin, logged to the console and sent to
the client in the reveal packet. It was **persisted nowhere**. So the only way
to answer "is the wheel still opening on time?" was to reconstruct it by hand
out of `table_seats` and `spin_reserve_ledger` — which is exactly how round
18's measured **p50 3.02s** drifted to **p50 13.7s, p90 28.3s** over a single
day with nothing on the platform noticing.

A number a rule is written in terms of, that nobody stores, is a rule nothing
can enforce.

`20260831153436_the_wheel_is_late_and_nothing_was_measuring_it.sql` adds
`tournaments.spin_reveal_lag_ms`, written on the UPDATE that already carries
the multiplier, prize pool and blind structure — no extra round trip in the
hot start path being measured — plus `v_spin_reveal_latency`: hourly p50/p90/
p99/worst, `past_the_lead_in` (spins that missed the one-second rule outright)
and a `breach` flag at 5s p50.

## 5. What this does NOT claim

The engine is still late — that is why the re-anchor keeps firing, correctly
now. This change makes the lateness **honest and measurable**; it does not make
it go away. The lag now lands in a column with a view over it, so the next
person to look has a number rather than an afternoon of archaeology.

## Verification

- full server suite: **282 files, 3,157 tests, all green**
- `spinRevealWindow.test.ts`: 12 tests, including the regression pin
- migration applied to production and its assertions passed at apply time
- three manifests regenerated so the new column, view and function are visible
  to the CI gates
