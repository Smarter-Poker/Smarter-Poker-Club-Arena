# An owed engine release is offered until production holds it

2026-09-27. `stage-engine-release.yml`, `audit-engine-provenance.sh`,
`tests/an-owed-engine-release-is-offered-until-production-holds-it.law.test.ts`.

## What happened

From 15:09 UTC on 2026-09-26 to 15:03 UTC on 2026-09-27 no engine release
reached production (`ca_engine_deploy_attempts`: last shipped f2e484a3d1 at
14:09 on 09-26, next shipped 4946473bb6 at 16:05 on 09-27). The only request
for the newest engine commit, 9e275e1c1a (run 36250934873), waited through two
shut certificates and ended at 17:22:48 on 09-26. Nothing offered it again.

The stager decided "is a release required" from one question: did THIS push
change the engine tree. The next 42 commits on main changed the database, the
client and tests, so every stager run printed
`Engine runtime release required: false`. Production fell 61 commits behind
main. The gate was shut the whole time (stopped-custody tables, fixed by #5409),
so a re-offer would not have shipped before 15:00 on 09-27; but the lane had
no way to deliver the moment the gate opened except an unrelated engine merge.

## The cause

The stager answered the question of the moment a commit merges. The question
the release lane owes is whether production holds the newest engine code.

## The fix

When a push does not change the engine tree, the detector reads the live
engine's `releaseSha` from `/health` (no-cache headers) and asks the same
containment question `audit-engine-provenance.sh` asks. If production does not
contain the newest engine-affecting commit on main, the commit is still owed
and `offer_reason=behind` marks it `release_required=true`.

A separate decision step in the signal job then refuses to offer when:

- a receiver run for the same SHA is queued or running (it is already waiting
  for its break), or
- a receiver run for the same SHA was created less than 50 minutes ago.

Fifty minutes is under one hourly break period, so every window can be
offered, and over the ~15 minutes a receiver takes to fail its own preflight,
so a build that cannot pass costs at most one test matrix an hour, not one per
merge. A push that changes engine code is sent exactly as before.

"Could not tell" is its own outcome: an unreadable `/health` or a served SHA
outside protected main gives `offer_reason=unknown`, a warning, and no offer on
that basis. An unreadable run list fails the step rather than assuming the
lane is empty.

## What it is not

It is not a second publisher: the same one event type goes to the same one
receiver with every gate it had. It is not a timer and not a chain off a
finished release: it is driven only by protected-main pushes (CLAUDE.md 10.85,
`no-workflow-gains-a-new-timer`). Residual: with no main pushes at all, nothing
offers the release until the next push. At the measured merge rate that is
minutes; it is stated here rather than hidden.

## The alarms during the 23 hours

- `PokerEngineCannotBeReplaced` (critical) fired 7 times into the durable
  operational inbox (`operational_alert_events` 145096 ... 158011), every
  4 hours. All 7 are still `investigation_status = new`.
- `EngineReleaseGateNeverOpens` (critical) fired from 12:06 on 09-26 (event
  143776, 7 deliveries); one investigation recorded the shut certificate.
- SMS paging was retired on 2026-09-13 by owner ruling; the critical email
  route exists, but its delivery is not observable from here.
- The GitHub-side starvation check (`check-engine-deploy-starvation.mjs`)
  errored in every production-integrity-audit run ("6 consecutive engine
  release attempts have shipped nothing over 245.7 minutes"), but that
  workflow has failed on every run since at least 2026-09-21, so its error
  reached nobody.

Neither Prometheus alert measures "production behind main"; both measure the
certificate. With this change the owed release keeps producing attempts, so
the starvation check's attempt count now grows with the outage instead of
freezing at the last refusal.

## Proof

- New law: 13 of 13 pass; against the pre-change workflow 11 of 13 fail,
  including the behind-main fixture.
- `clientEngineReleaseRouting`, `the-deploy-can-always-ship`,
  `no-commit-left-behind`, `no-workflow-gains-a-new-timer`,
  `legacyEngineCheckpointAdmission`: 113 of 113 pass.
