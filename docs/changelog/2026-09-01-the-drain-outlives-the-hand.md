# The drain gave up before the median hand ended

2026-09-01. Following #2406 onto the box, and correcting the conclusion I had
posted there earlier.

## The classification was wrong, and correcting it inverts the finding

The issue said chip damage tracked restarts with **no deploy** behind them. It
does not. The earlier cross-reference compared each restart against the _start_
time of `Auto-Deploy Hetzner Engine` runs, and those runs take 6 to 14 minutes
and SSH into the host near the **end**:

| restart (UTC) | deploy run    | ran                     |
| ------------- | ------------- | ----------------------- |
| 00:40         | `33455284038` | 00:34:18 → **00:40:32** |
| 02:13         | `33461369129` | 02:07:46 → **02:14:09** |
| 03:54         | `33467092428` | 03:40:59 → **03:54:54** |

Corroborated on the host: `sshd` accepted publickey logins from Azure ranges —
GitHub-hosted runners — at exactly 00:39, 02:13 and 03:46 UTC and at no other
time. Rebuilt with the corrected labels:

| bucket               | games | wrong | rate      |
| -------------------- | ----- | ----- | --------- |
| **deploy restart**   | 149   | 12    | **8.05%** |
| no-deploy restart    | 114   | 3     | 2.63%     |
| no restart in flight | 2,993 | 45    | 1.50%     |

The damaging path is the _drained deploy_, at 5.4x baseline. Which is a much
better problem to have, because we control it.

## Why: the drain expires on half the hands it is meant to save

`shutdown()` in `server/src/index.ts` calls `drainHands(18000)`, and
`pauseAfterHand()` parks a table at the **end of its current hand**. The
comment above it justified 18s with "a hand on this platform runs ~20s".

That was an estimate. Measured over **41,269 real hands** in a three-hour
window:

```
p50 17.2s    p90 48.2s    p99 98.2s
47.2% of hands run longer than 18s
23.8% longer than 30s
11.6% longer than 45s
```

So the drain was expiring with roughly **half** the tables still mid-hand, on
every restart, logging "budget expired, stopping anyway" — and stopping them.
That is the voided hand it exists to prevent, and it lines up with the 8.05%.

## The change

The ceiling is not Docker's `docker stop -t 45`; it is the **40s outer race**
inside the process, which must finish before SIGKILL. The three numbers now sit
together with the reasoning that ties them, instead of being magic numbers 40
lines apart:

```
docker stop -t 45   Docker's grace before SIGKILL   (server/scripts/engine-up.sh)
SHUTDOWN_CAP_MS 40s everything must finish inside this
DRAIN_BUDGET_MS 28s of that, parking tables at a hand boundary
                    leaving 12s to flush state and 5s of margin
```

28s leaves the flush exactly the 12s the 18s budget left it, and lifts the share
of hands the drain can save from **52.8% to about 74%**.

Getting past ~74% means raising the 45s stop grace itself — a deploy-script
change with its own 180s lock margin to weigh. Deliberately not bundled here.
The measured distribution above is what that decision needs.

## The pin, and the first version of it that was useless

`tests/unit/shutdownBudget.law.test.ts` asserts the budgets nest: drain < cap <
grace, with at least 10s left to flush, and the drain longer than a median hand.

The first draft asserted `drain > 17_200`. **The broken 18s budget passed it,
with 800ms to spare.** A pin that green-lights the bug it was written for is
worse than no pin. The bar is now 1.5x the median, and I checked it red against
18s and against a cap that exceeds the stop grace before believing it.

## Ruled out, so nobody re-runs them

- **Not OOM, not a crash.** `docker inspect`: `ExitCode=0`, `OOMKilled=false`,
  `RestartCount=0`. Zero OOM events in `dmesg`. 2.1 GB available.
- **Not the supervisor.** `club-arena-supervisor.timer` fires every 60s but
  _observes_ the replacements, filing them as `container was replaced
(deploy/recreate: <old> → <new>) — not churn`. No `RECOVERY` in the window.
- **Not a stray cron or timer.** Root's crontab is three unrelated jobs.
- **Not `update-hetzner-env.yml`**, the other workflow that can restart the
  engine: last run 2026-08-16.

Two restarts are still not deploys. **04:10** was the engine restarting itself
54 seconds into its own boot (`container restarted again within boot grace`).
**01:15** has no deploy, no SSH and no supervisor line, and remains unexplained
— it is also the one that did zero damage.

## Two existing pins had to move with it

`drainProtectsEveryHand.test.ts` and `deployCannotPinStaleCode.test.ts` both
read the budget out of the source with `/drainHands\((\d+)\)/`. Naming the
constants broke that regex, and CI caught it — correctly, since a pin that
cannot find the value it guards is a pin that has stopped guarding.

They now resolve the value _through_ the name (falling back to a literal, so an
inlined number still reads), which is the same property asserted against a
different spelling. The one real change is the floor in
`drainProtectsEveryHand`: it required `budget >= 15_000` against the "~20s"
estimate, and now requires 1.5x the measured p50 of 17.2s. Under the old rule
an 18s budget passed both files while expiring on 47% of hands.

Checked red against the old 18s budget before shipping: two failures across the
two suites, and 13 green once restored.
