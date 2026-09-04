# Autopilot asked every repo for a workflow only this one has

Date: 2026-09-04
Branch: `fix/autopilot-looks-for-a-workflow-only-one-repo-has`

`.github/workflows/agent-autopilot.yml` is enforced byte-identical across all
seven repos. Its "no CI run at all" repair - the 2026-09-02 fix that pushes an
empty commit onto a pull request nothing ever tested - asked
`gh run list --workflow ci.yml`. **Only Club Arena has a ci.yml.** The World
Hub's gate is `build-safety-gate.yml`, so there the answer was "none" for every
pull request, and the repair fired on every World Hub pull request older than
fifteen minutes, after every real push. Five such commits landed in one day.

Each one is a second full copy of the World Hub's thirteen workflows, queued
behind the next pull request's checks on six runners that were already making
0.2-minute jobs wait 8-14 minutes - and a later merge, because the new head
restarts auto-merge's wait.

The same would happen in any repo whose gate is not literally named ci.yml.

## The fix, asked in a way that is true everywhere

- **"No CI at all"** is now "no `pull_request`-event workflow run exists for
  this head", from `GET /actions/runs?head_sha=…&event=pull_request`.
- **"Red"** is now "a check the BASE BRANCH'S RULESET requires has failed",
  read from `GET /rules/branches/<base>` and the pull request's own
  `statusCheckRollup`. It deliberately ignores optional suites: the World Hub's
  E2E workflow has been red on main for a day, and counting it would have made
  every behind-by-one pull request refresh on every sweep.

`tests/a-shared-guard-names-no-workflow-only-one-repo-has.law.test.ts` refuses
`--workflow ci.yml` in any shared guard.

## Rollout

Shared file: this must land in all seven repos or `estate-integrity` reports
the drift hourly. It goes to Club Arena (this PR) and the World Hub in the same
session; the other five are next.
