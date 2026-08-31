# Nothing was watching the wheel stay fair

**2026-08-31 — Spins phase 1 of 7: the fairness view and the watchdogs nobody reads**

## The gap

Spin charges no rake. There is no fee row, no ledger line, nothing to
reconcile — the 8% is engineered into the multiplier distribution, and the
entire commercial design of the format rests on one equality:

```
E[multiplier] = seats × (1 − rake_rate) = 3 × 0.92126 = 2.7637726
```

Nothing had ever checked it. Not a job, not a dashboard, not a test. The
first and only verification in the platform's life was a human typing SQL
during the 2026-08-31 audit (21,250 draws, E = 2.7628 — sound). If that mean
had drifted, players would quietly have paid a larger edge than the lobby
advertises and no part of this system would have said a word.

`v_spin_draw_distribution_7d` was not that check. It compares per-tier counts
against expectation, which is a **shape** test. A distribution can look right
tier by tier and still carry a materially wrong mean, because a handful of
extra 100x draws move E further than a thousand extra 2x draws. Only the mean
tests the equality.

Four more spin views had the same problem in the other direction: they
existed, they were correct, and nothing read them. `v_spin_unpaid_settlements`,
`v_spin_draw_booking_gaps`, `v_spin_unfilled_waits`,
`v_tournament_rake_attribution_gaps` each had a repair job — and a repair job
that stops running looks exactly like a repair job with nothing to do.

## What shipped

**`v_spin_draw_fairness`** — realised E against spec over 1h/24h/7d windows,
as a **z-score** rather than a tolerance. "Is it 2.7638?" is unanswerable and
any fixed tolerance is simultaneously too tight at 22,000 draws and far too
loose at 200: the spec standard deviation is 1.6229, so the standard error of
the mean is 0.011 at 22,000 draws and 0.036 at 2,000. The drift flag is
|z| ≥ 4 on ≥ 2,000 draws — roughly a 1-in-16,000 false alarm.

It also reports `constrained_draws`. `fn_spin_draw_multiplier` drops tiers the
reserve pool cannot cover and renormalises, which lowers the conditional mean
through no fault of the RNG. A drift alarm that could not separate "the RNG is
wrong" from "the pool was thin on Tuesday" would send every reader to the
wrong explanation first.

Live on production at ship time:

| window | draws  | realised E | spec E   | z         | realised edge |
| ------ | ------ | ---------- | -------- | --------- | ------------- |
| 1h     | 108    | 2.564815   | 2.763773 | −1.27     | 14.51%        |
| 24h    | 2,489  | 2.740056   | 2.763773 | −0.73     | 8.66%         |
| 7d     | 22,082 | 2.760846   | 2.763773 | **−0.27** | 7.97%         |

`constrained_draws` is 0 in every window. The draw is fair.

**`fn_spin_metrics()`** — one round trip behind every spin gauge, so a 15s
scrape does not become six queries.

**`server/src/services/SpinMetrics.ts`** — 19 `poker_spin_*` gauges on
`/metrics`, following the `TournamentMetrics` fail-loud contract: a failed
refresh keeps the last good snapshot and `poker_spin_metrics_stale_seconds`
tells the truth about its age, so a blind collector is visible as a blind
collector rather than as a healthy platform.

With one addition. **0 ms of reveal lag is the perfect score**, so emitting 0
for "no spins ran" would report the best possible health at the exact moment
the collector knows nothing. Unmeasured percentiles are **omitted**, and
`poker_spin_reveal_window_spins` says why they are missing.

**`infra/monitoring/spin-rules.yml`** — 8 alerts, every expression verified
against a gauge the engine actually emits. The booking-gap rule measures
`delta(...[1h]) > 0` rather than a level, because the 11 historical rows
(2026-08-22 to 08-24, cause closed, 293.00 chips of pool overstatement) are a
remediation decision, not an incident; a rule that fired on the standing count
would have been muted by the end of the week.

**Rake attribution back-pay, in the engine loop.** `fn_repair_` retries
settlements the settle path recorded as failed. It cannot see the ones that
were never measured at all — 40,055 rows on 2026-08-31, years of VIP points
and agent commission owed to 585 players. Draining that was a one-off by hand;
keeping it drained cannot be.

**A deadlock is not a verdict.** `fn_backpay_tournament_rake_attribution`
stamps `attributed_users = -1` when attribution throws, so a thrown row cannot
pin the queue — correct, and the reason the 40,055-row drain finished. But the
loop selected `WHERE attributed_users IS NULL`, so **nothing ever retried a
stamped row**. Every one of the 18 rows stamped during the drain carried a
deadlock message and every one attributed cleanly on a manual reset. The loop
now re-attempts rows whose error names a retryable condition, clears the error
on success, and reports the rest as `needs_a_human`.

**One overrun is news; thirteen hundred is noise.**
`Tournament.spin_reveal_window_overrun` fired once per spin — ~2,500 spins a
day, 88–97% of them overrunning, so a single call site produced over a
thousand identical error reports daily, all true and together loud enough to
bury everything else. It now opens an incident immediately and then aggregates
on a 10-minute window with the count and worst lag attached. The per-spin
detail did not disappear; it moved to `poker_spin_reveal_lag_p50_ms` at full
resolution, and the message says so.

## What this exposed

`poker_spin_reveal_lag_p50_ms` reads **4,767 ms** on production, p90 9,724 ms,
worst 27,039 ms, with 130 of 139 spins in the last hour past their own 1-second
lead-in. Every one of those wheels still plays in full — the re-anchor
guarantees it — but the three players sat looking at a table first. That is
the start path, and it is phases 3 and 4.

## Tests

- `server/src/services/spinsAreObservable.law.test.ts` — 14 pins, including
  that an unmeasured percentile is absent rather than zero, that a never-
  succeeded collector reports past the 600s alert threshold, that every metric
  named in a rule expression is one the engine emits, and that the fairness
  runbook names `poker_spin_draw_constrained` before anyone audits the RNG.
- `server/src/tournament/spinOverrunReporter.test.ts` — 11 pins on real
  numbers, including the regression pin: 2,400 overrunning spins over 24h
  produce at most 145 reports, and never zero.

Full suites green: 3,308 server tests, 10,660 client tests, both typecheckers,
`check-monitoring-drift`, `check-required-columns`, `check-definer-authorization`.
