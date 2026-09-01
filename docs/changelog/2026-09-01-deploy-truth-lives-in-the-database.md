# 2026-09-01 - Phase 4 of 6: deploy truth lives in the database

## The question nothing could answer

`auto-deploy-hetzner` is green whether it ships or skips, and skipping is
usually the correct action: the restart windows (6pm, 10pm, 4am, 10am, 2pm
America/Chicago) exist so a restart never voids a live hand. The cost is that a
green tick has never meant "the engine is running this commit".

Two incidents made that concrete. On 2026-08-31 the engine sat 3h50m behind
main with the restart window standing open, because the window's cron fired
once at the top of the hour and GitHub never delivered that tick. Later the
same night GitHub Actions stopped starting jobs for this repo at all - every
workflow failed in seconds with no steps and no logs - which is the reason this
watchdog cannot live in Actions. A watchdog that shares a failure domain with
the thing it watches goes quiet in exactly the incident it exists for.

Measured this morning, before any of this: the engine was running `bda90d71`,
claimed at 04:11 UTC, while main was at `fe640965`. Four commits touching
`server/**` were merged and not running, including two horse-law fixes shipped
today. Every deploy run since had reported success. Every one of them printed
`DID NOT DEPLOY - this run shipped nothing`, and nothing anywhere added those
two facts together.

## What answers it now

Two halves, each in the layer that can see its half.

**What is RUNNING** was already in the database and nobody was reading it:
`engine_table_leases.engine_version`, written by every engine process on every
lease heartbeat. That is ground truth about the build actually dealing cards.

**What was OFFERED** is new. `auto-deploy-hetzner` now records every run into
`ca_engine_deploy_attempts` - ship or skip, with the reason - through
`fn_ca_record_engine_deploy_attempt`. That step is `if: always()`, because the
runs that skip are the whole point.

`fn_ca_engine_deploy_truth_watch()` runs from pg_cron every ten minutes
(`ca-engine-deploy-truth-10m`) and raises on four things:

| alarm                                   | fires when                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `deploy_truth.engine_heartbeat_stopped` | leases are held and nothing has heartbeat for 180s                                                 |
| `deploy_truth.engine_split_brain`       | two builds hold leases at once - the 2026-08-20 two-dealers-one-table incident                     |
| `deploy_truth.pipeline_silent`          | no deploy attempt recorded in 6h; the shipper itself has stopped                                   |
| `deploy_truth.engine_behind_target`     | the running build differs from what has been offered for 8h, longer than any legitimate window gap |

The pipeline reporting in is what makes **silence** an alarm. A watchdog that
only compares two numbers cannot tell "nothing needed shipping" from "nothing
is running the shipper". One that expects a heartbeat from the shipper can.

Each alarm raises once per episode and resolves itself when the condition
clears. An alarm that re-raises every tick is a mute button; one that never
resolves is a permanent red light nobody looks at.

## What the drill caught

The first version called `fn_raise_financial_alert`, which throws
`Authentication required to raise a financial alert`. A pg_cron tick has no
authenticated caller, so that version would have detected every incident and
reported none of them. It was caught by drilling the function inside a
transaction rolled back by RAISE, before anything was scheduled - a fake
20-hour-old attempt row for a sha the engine is not running. The corrected
version uses `fn_raise_server_financial_alert` and the same drill returned:

```
findings: [{kind: engine_behind_target, running: bda90d71, target: deadbeef}]
raised:   [{severity: critical, source: deploy_truth.engine_behind_target}]
```

then rolled back, leaving no row behind.

`tests/unit/deployTruthIsAnsweredByTheDatabase.test.ts` pins that mistake so it
cannot come back: the watcher must raise through the systems path, the workflow
step must be `if: always()`, the recorder must never exit non-zero, and each of
the four alarms must both raise once and resolve.

## Not done here

This says the engine is behind. It deliberately does not deploy - section 1.3
forbids that, and a watchdog that can restart the engine is a second deploy
path nobody is watching.
