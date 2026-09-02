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

## Addendum — the scrape job that was never committed

Deploying `spin-rules.yml` to engine-01 surfaced a second, unrelated gap. The
live `prometheus.yml` on the host carried a `turn_relay` scrape job — voice
relay monitoring, added directly on the box on 2026-08-28 — that had **never
been committed**. `deploy.sh` resets the host to the repo, so the next routine
deploy would have silently deleted it, and the three `turn-relay` alert rules
in `alert-rules.yml` would have gone on evaluating against no data, which
reads as healthy.

`check-monitoring-drift.mjs` could not see it: checks 1–5 verify that rule
files are loaded, resolve, are mounted at matching paths and declare rules.
None of them look at scrape targets, and a rule file that loads perfectly
against a target nobody scrapes alerts on nothing.

The job is restored to the repo verbatim, and the drift check gained a sixth
assertion pinning the scrape-job list. It cannot detect a job added on the
host and never committed — nothing in the repo can — but it makes **deleting**
one a deliberate act that shows up in a diff. Verified by renaming the job and
watching the check exit 1.

## Deployed

`spin-rules.yml` is live on engine-01: Prometheus reports 8 rules across
`spin-fairness`, `spin-money` and `spin-experience`, `promtool check config`
passes on all 7 rule files, and `turn_relay` survived the config swap.

## Addendum 2 — the deploy said "coalescing" and meant "wrong time of day"

The engine gauges could not be verified live at ship time, and finding out why
cost fifteen minutes to a message that was confidently wrong.

A restart-window gate landed on main today: engine deploys run only at 7am and
7pm America/Chicago, or on a dispatch with `force=true`. The `DID NOT DEPLOY`
step's reason logic was never taught about it, so a run blocked by the window
reports:

> coalescing — the engine restarted too recently, or it is already on this
> commit

The engine had been up for 45 minutes at the time, comfortably past the
1200-second spacing threshold. The stated reason was simply untrue, and it
points at a gate that is working correctly, so anyone acting on it investigates
the wrong thing. A wrong reason costs more than no reason: it is confidently
wrong, and it is the first line anybody reads.

The reason now names the window gate first, and the step's own condition lists
it, so the "DID NOT DEPLOY" marker cannot depend on `dedupe` happening to
short-circuit for it.

**Deployment status of this phase.** The database and monitoring halves are
live and verified right now: the fairness view, `fn_spin_metrics`, the repair
fixes, and `spin-rules.yml` loaded into Prometheus on engine-01 (8 rules across
three groups). The engine half — the `poker_spin_*` gauges themselves — lands
at the next restart window without further action. Forcing it would restart the
engine while 105 tables are dealing, which is exactly what the window exists to
prevent, so it was not forced.

## Addendum 3 — the booking-gap rule got simpler once the gauge got bounded

The first cut alerted on `delta(poker_spin_draw_booking_gaps[1h]) > 0` because
the gauge counted the whole history, and a rule on that level would have fired
forever on the eleven closed rows from 2026-08-22.

Bounding `fn_spin_metrics` to fit inside a scrape changed that: the gauge now
counts only spins that **ended in the last 24 hours**, so those eleven are
outside it by construction and the rule is a plain `> 0`. That is not just
tidier — `delta()` over a gauge cannot tell a genuine new gap from the counter
resetting on an engine restart, so the simpler rule is also the more correct
one. The same pass corrected two rule descriptions that still named
`v_spin_unpaid_settlements` as the source after the gauge had moved to
`fn_spin_unpaid_settlements(24)`; a runbook that names the wrong query is the
same defect as a deploy that names the wrong gate.

Re-verified on engine-01: `promtool check rules` passes, all 8 rules load
healthy and evaluate.
