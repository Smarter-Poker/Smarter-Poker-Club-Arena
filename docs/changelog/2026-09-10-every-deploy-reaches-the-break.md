# 2026-09-10 - Every engine deploy reaches the break, and green means shipped

> **SUPERSEDED / HISTORICAL: DO NOT IMPLEMENT THIS RELEASE DESIGN.** This file
> records an intermediate 110/130-minute GitHub-owned cutover and watchdog era.
> The current authority is the exact-SHA staging event plus the durable Hetzner
> host transaction. The watchdog dispatch, Actions-side hand-on, failed-run
> retry, and cancellation recovery described below are retired.

## What Dan saw

"Back to back to back errors on every deployment." Between 15:57 and 19:00 UTC
not one engine deploy shipped, while production crash-looped on `7732b971`
(horse decision worker deadline -> `GameServer.shutdown_deadline` -> exit, 14+
restarts) and the fix (#4190) had been on `main` since 16:51.

## What was actually happening (read from runs, the ledger and the host)

Every deploy since 15:57 fell into one of three buckets:

| run         | started              | outcome                | why                                                                                                   |
| ----------- | -------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| 34501790172 | 16:23                | cancelled 16:42        | cancelled by an agent                                                                                 |
| 34505100894 | 16:55                | green, shipped nothing | started at :55, the next break was 49m away, the budget was 34m                                       |
| 34508883367 | 17:32                | cancelled 17:48        | cancelled by an agent before the break                                                                |
| 34511390657 | 17:57                | green, shipped nothing | started at :57, same arithmetic                                                                       |
| 34512893031 | 18:12                | cancelled 18:32        | waiting correctly at the gate; cancelled by the Stage-B coordinator that had reserved the 18:55 break |
| 34515705774 | 18:39 (the :35 tick) | cancelled 18:41        | same coordinator                                                                                      |
| 34516171966 | 18:44                | green, shipped nothing | reached the gate at 18:56:38, after the break opened                                                  |

Two structural defects made that possible, and this change fixes both:

1. **The deploy could only serve starts between about :10 and :44.** The
   55-minute ceiling was derived for the `:35` tick, assuming a staged run reaches
   the gate in ~1 minute (the law test used 6). It takes 10.3-11.7 minutes: the
   server suite runs before the gate on every run. And the tick is not the
   caller: GitHub delivered 3 of ~19 ticks on 2026-09-10, the DB dispatcher was
   retired by `20260910183316`, so every run was dispatched by
   `engine-watchdog.sh` or an agent at whatever minute they ran. Any start
   outside the viable window staged its image, printed a notice, went green and
   waited for a tick that did not come.
2. **Green did not mean shipped.** The only place that said `shipped=false` was
   `ca_engine_deploy_attempts`.

## The change

- `timeout-minutes` 55 -> 110 and `JOB_TIMEOUT_S` with it, derived from the worst
  START MINUTE: setup + suite 12 + cold build 18 + a full hour's wait 60 +
  cutover reserve 9 = 99. A run started at any minute now waits in its break
  gate for the next `:55` it can reach and cuts over there.
- The gate poll gets a wall-clock deadline, so slow `/health` answers cannot
  stretch it past the budget and let the job timeout kill a cutover.
- `engine-watchdog.sh`: `INFLIGHT_STALE_MIN` 65 -> 120 (must exceed the ceiling,
  or a run legitimately waiting for its break is treated as a zombie), and its
  dispatch message says which break the run will make instead of promising a
  `:35` tick.
- A final `Verdict` step: GREEN only when production serves the commit (shipped,
  already live, or coalesced inside the same break); RED when the run should have
  shipped and did not. It runs last, after cleanup, so the rollback (keyed on
  `failure()`) can never react to it, and it reads the same `SHIPPED` expression
  as the ledger.
- `DID NOT DEPLOY` no longer says a break-gate skip is "the correct action" or
  that "the next hourly tick" lands it.

## Pins

- `tests/the-deploy-can-always-ship.law.test.ts`: EVERY start minute 0-59, staged
  (12m) and cold (30m), reaches the next break within the budget; the watchdog's
  stale line exceeds the ceiling; the watchdog no longer promises a `:35` tick.
  Fails on the old workflow ("a run started at :00 reaches the gate after 12m and
  must wait 45m for :56, but only has 34m of budget"), passes on the new.
- `tests/unit/deployAndPublishAreHonest.test.ts`: the verdict is last, always runs,
  shares the ledger's `SHIPPED` expression, is red on a declined gate and green on
  already-live/coalesced, and sits after the rollback.
- `tests/engine-watchdog-asks-production.test.ts`: the stale line is derived from
  the deploy timeout instead of pinned at 65.

## Not in this change

The collisions between agents (a coordinator cancelling deploys to protect its
own stopped-engine cutover) need one production lease that the deploy honours:
with this change, a run that finds the window taken can simply wait for the
next break instead of being cancelled. That lease is being built separately
(`server/scripts/engine-production-authority.py`, not yet merged).

## Follow-up the same evening: the colours after #4208

An adversarial review of #4208 found the new colours would still lie in three
places, fixed in the follow-up:

- **A superseded run was red.** The control-plane check refused any run whose
  workflow commit was no longer main's tip with `exit 1`: 8 of 8 red deploy runs
  on 2026-09-10 were this, none a ship failure, and one opened a false "deploy
  train is failing" alarm (#4109). With runs now holding the group for up to an
  hour, a run queued behind one almost always starts after main moves. An
  ANCESTOR of main now stands down green (`superseded`), touching nothing; a
  commit that is not an ancestor of main is still refused, red.
- **Already-live runs announced the commit was NOT on production.** The dedupe
  now names each skip (`already_live`, `coalesced`, `superseded`), the step that
  exists to be seen prints a notice for already-live, and the ledger records
  which one it was (and `cancelled before a verified cutover` for cancellations).
- **The Verdict could paint a run red while production served the commit** (a
  dedupe that read an unreadable `/health`). It now asks production once,
  cache-busted, before painting red; unreadable stays red and says so. The break
  gate exports `gate_kind` on every decline, and the Verdict allowlists exactly
  one deliberate kind, `lease_held_elsewhere`, for the production lease to use.

Also: `timeout-minutes` 110 -> 130 so a failed cutover's ROLLBACK (~8m) and the
always() tail can finish at the worst start minute; `INFLIGHT_STALE_MIN` 120 ->
270 because a run's age includes time spent pending behind another (2 x 130 + 10);
the dead "Record that this deploy run started" step and its script are removed
(it wrote to `fn_ca_record_engine_deploy_start`, retired live by
`20260910183316`, and warned on every run); the watchdog's train alarm names the
workflow (so `check-main-is-green` sees it as loud), counts `timed_out`, and no
longer tells the reader to "fix main, never the gate" when the failing step is the
Verdict.
