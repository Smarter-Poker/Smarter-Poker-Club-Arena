# A stood-down verification is not green

2026-10-26. CI/workflow only; no client, engine, migration or financial change.

## What was wrong

`post-deploy-e2e.yml` stands down when the publisher it listens to was
replaced before it reached the origin: the gate succeeds, `should_run` stays
empty, every lane skips, and `record-post-deploy-verdict.mjs` records nothing.
GitHub then concluded the whole run `success`, so "Post-Deploy E2E <sha>" read
green for a release no browser looked at.

`check-main-is-green.mjs` steps over `cancelled` and `skipped` runs because
they carry no verdict (`tests/a-skipped-run-is-not-a-green-run.test.ts`), but
it counted these stand-downs as passes. Measured 2026-10-25: failed
verification 40242809027 (client job red) was followed by stand-down
40243837996 concluding `success`, which the detector would read as main
recovering.

## The fix

A final job, `stood-down-is-not-green`, runs only when the gate succeeded
without `should_run`, the event is `workflow_run`, and the verdict recorder
has already succeeded. It cancels its own run (`actions: write`, that job
only), so the run concludes `cancelled`: the conclusion CLAUDE.md 10.83
already reserves for "superseded by a newer publish". Nothing pages on it and
nothing reads it as a pass. Running last means the recorder never sees a
cancelled gate, which it correctly treats as a fault. If GitHub refuses the
cancellation three times, or the run is still alive 300 s after it was
accepted, the job fails out loud rather than falling back to `success`.

## Tests

`tests/unit/aStoodDownVerificationIsNotGreen.test.ts` (7 cases) pins the
condition, ordering, permissions, exact self-cancel, the loud failure path,
the recorder's unchanged "nothing to verify" decision, and that the detector
keeps reporting the failure a stand-down follows. It fails on the previous
workflow. All 31 test files that read this workflow or the verdict logic pass
(687 tests), plus `record-post-deploy-verdict.test.mjs` (38).

## Follow-up: the job is stopped by its own cancellation

Live on main, stand-down runs 40268560267 and 40269218566 concluded
`cancelled`, as intended, but the `stood-down-is-not-green` job itself showed
`failure`. GitHub does not stop an `always()` job when its run is cancelled,
so the step's accepted cancel did not end it. It sat out its 300 s guard and
reported "still running". The job now uses `!cancelled()`, which still
evaluates past skipped needs and is stopped by the run's cancellation, the
same pattern ci.yml uses for its heavy jobs. The unit test pins
`!cancelled()` and refuses `always()`.
