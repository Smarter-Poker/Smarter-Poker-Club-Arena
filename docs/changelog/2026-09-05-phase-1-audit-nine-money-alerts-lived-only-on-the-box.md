# 2026-09-05: the Phase 1 audit - nine money alerts lived only on the box

A deep verification pass over Realtime programme Phase 1, before starting
Phase 2. Three defects, all already shipped.

## 1. A degraded horse action was neither counted nor timed

The horse instrumentation sat above the check/fold fallback in
`scheduleHorseAction`. A horse whose intended action is REJECTED still reaches
the felt through the degrade - and was invisible to both instruments. It now
keys on the same `applied` that `markProgress()` does, so it counts whichever
of the three attempts landed. Unequal treatment of a horse is a 10.5 defect,
and a hole in the series either way.

## 2. Nine money alerts existed in no repository

`settlement` (5 alerts) and `money-health` (4) were live on engine-01 and
present in no repo file. `infra/monitoring/deploy.sh` symlinks the repo's
`alert-rules.yml` over the live path, so the first `deploy.sh` run would have
deleted HandsAreFailingToSettle, NoHandsAreSettling, SettlementsStuckMid-
StateMachine, MoneyAlertsGoingUnread and five more, with no diff and no error.

## 3. The SLO rule files in the repo were empty shells

`slo-alerts.yml` was literally `groups: []` with a comment saying SLO alerting
was disabled, while `slo-objectives` and `slo-recording` ran 14 healthy rules
on the box. Same symlink, same silent deletion.

## What changed

All three recovered verbatim into `infra/monitoring/`, with the previous file
contents preserved as comments. The repo is now a superset of what is live, so
a deploy can only add. All seven rule files promtool-validate against the live
Prometheus: 73 rules.

`tests/an-alert-that-is-live-is-in-the-repo.law.test.ts` names every group
observed live on 2026-09-05 and fails if one stops being versioned. It found
defect 3 on its first run.

## Still open

The repo is not yet the SOURCE of truth - nothing syncs these files to the box
and nothing compares them. `/opt/smarter-poker-monitoring-src`, the clone
deploy.sh expects, does not exist on engine-01. A reconciler is Phase 7 of
`docs/REALTIME-CONNECTIONS-PROGRAMME.md`. Until then: an alert is live when
`/api/v1/rules` says so, never because it merged.
