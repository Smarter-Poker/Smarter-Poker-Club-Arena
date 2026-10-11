# A superseded retained runtime is not a red certificate

2026-10-11.

## What happened

Post-Deploy E2E run 38170604116 certified publisher 38169740342, which had
retained runtime `5c1e013` with verification source `a9e963a` (a
documentation-only backlog, so no new bundle). The certificate waited behind
the production lock and its client browser lane started at 20:39 UTC, 48
minutes after the publish. By then production served `a76ebb9`, three commits
later on protected main.

The lane's "Take the specs from the commit production is actually serving"
step opened its retained-runtime branch with a bare
`test "$LIVE" = <client_target_sha>`. It exited 1 with no message, every
later browser step was skipped, and the lane went red with "Reports missing
or unreadable ... the suite did not run" and "Phase 1 customization coverage
was missing or incomplete". Nothing on the live site had been examined. That
is "could not tell" reported as a defect (CLAUDE.md 10.86 rule 1). The same
line sat in the live-table lane.

## The fix

In both lanes, the retained-runtime branch now:

- keeps the exact path unchanged when production still serves the retained
  runtime (harness receipt proof, specs from the verification source);
- when production serves a different SHA, requires that SHA to be a forward
  protected-main descendant of the retained runtime and then falls through to
  the same lineage alignment every non-retained run already uses (same,
  ancestor, or descendant of the checkout). The release-window and Phase 1
  bracket steps classify anything that moves after that, as before;
- still fails hard, with a named error, on a rollback or any live SHA that is
  not a descendant of the retained runtime.

The seal job already binds to the lane's recorded `client_sha` (what was
actually tested), not to the gate's target, so nothing downstream changes.

## Pinned by

`tests/production-e2e-provenance.law.test.ts`, "a retained runtime superseded
before the browsers start": extracts both align steps from the workflow and
runs them in a real git fixture for the forward, exact and rollback cases.
