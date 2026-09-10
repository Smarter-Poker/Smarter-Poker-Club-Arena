# Every engine merge starts its own deploy; nothing has to notice one is missing

**Dan, 2026-09-10:** "i do not want any watch dogs, i want hard coded fixes that
solve this problem and prevent it from breaking or regressing, i want any and
all pushes to be published in the order that they come in! ... don't just agree
with me, if im wrong tell me".

## What was wrong

The engine deploy (`auto-deploy-hetzner.yml`) had one scheduled start, a
`35 * * * *` cron, and GitHub delivered **3 of ~19** of its ticks on
2026-09-10. Everything else was started by dispatchers that existed only
because the cron did not come: `.github/scripts/engine-watchdog.sh` (which on
2026-09-09 cancelled the very run waiting in the break gate, three hours
behind), `schedule-liveness.mjs`, and agents by hand - each at whatever minute
it happened to run. A watchdog as the primary trigger is a band-aid on a trigger
that does not work.

## What it is now

- **A push to main that touches the engine starts a run** (`server/**` minus
  tests and sim - the same paths the watchdog measures "behind" against). A push
  is delivered every time.
- **It is not "restart on merge".** Every run waits in its break gate for a
  fresh `maintenance.readyForRestart` inside the announced :55 break (CLAUDE.md
  §13). A merge starts a run that waits; it restarts nothing.
- **The chain hands itself on, inside the workflow:**
  1. a run that starts after main moved the deploy CONTROL PLANE (this workflow,
     `scripts/ci`, `server/scripts`) dispatches current main before it stands
     down; an ancestor whose control plane is byte-identical to main's is not
     superseded at all - it ships its own commit, so a stream of client merges
     cannot keep the train in the station;
  2. a run whose break gate could not serve it (`no_certificate`,
     `staged_deferred`) dispatches its successor from its Verdict step, and the
     successor waits for the next break. At most one per break.
     A run that FAILED - tests, build, or a cutover that rolled back - does not
     hand on: retrying a broken commit every hour would restart production into it
     every hour. The next push, the fix, starts the next run.
- **No cron.** No restart-spacing ("coalescing") skip either: the :55 break is
  the spacing, and with nothing coming back later a coalesced run would strand
  the commit it was asked to ship.
- **`engine-watchdog.sh` reports and never dispatches.** It still says whether a
  run is in flight, and raises `DEPLOY TRAIN STOPPED` when the engine is behind
  and none is - which now means a run failed and nothing has been pushed since.
  That needs a person, not another dispatch of the same commit.
  `schedule-liveness` no longer covers the deploy, because it has no schedule.

## Where the ask had to bend

"Every push published in the order it came in" cannot mean one restart per push:
the engine restarts at most once per :55 break and main takes dozens of merges
an hour. It means **in order, by inclusion** - every break ships a commit that
contains every earlier push, in merge order, and never an older commit after a
newer one (the release seal is forward-only). The `deploy-hetzner` concurrency
group is the queue: one run in flight, and one pending run that GitHub replaces
with each newer push, so the pending run is always the newest push and a
replaced push is contained in the run that replaced it. Worst-case latency is
about two breaks (the in-flight run's break, then the pending run's).

The staleness alarm stays. Dan asked for no watchdogs as the MECHANISM; an alarm
that says the train has stopped is monitoring, and removing it would make a
failed run silent.

## Pins

- `tests/unit/deployAndPublishAreHonest.test.ts` - the push trigger, its paths,
  the one queue, the cutover behind the break gate, no cron, both hand-offs, the
  token that may dispatch, no event-specific bypass, and the control-plane rule.
- `tests/the-deploy-can-always-ship.law.test.ts` - no tick to rely on (the
  every-start-minute arithmetic is the whole law), no spacing skip, and the
  watchdog reports but never dispatches.
- `tests/engine-watchdog-asks-production.test.ts`,
  `tests/the-break-clocks-agree.law.test.ts` - the watchdog and the deploy gate
  agree on the break minute without a cron to compare against.
