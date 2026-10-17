# The natural multirun observation runs after a continuity failure

Run 39034908810 (an explicit `mobile_multirun: true` certificate) passed three
of its four live-table continuity cases. The MTT case failed because its one
subject table, in a 207-player tournament, was closed by table balancing
(five players relocated, three eliminated) before a blind level changed, with
12 seconds left of its budget. The natural two-run/three-run step had no
`if` status function, so GitHub's implicit `success()` skipped it, and the
whole natural observation was lost to an unrelated case.

The natural step now starts with `!cancelled() &&`. Every opt-in and fixture
guard it had is unchanged: repository dispatch, typed `mobile_multirun ==
'true'`, gameplay resumed, isolated account and spectator ready. The failed
continuity case still fails the job and its coverage step, so no failure is
hidden; a cancelled run still stops. The job's 98-minute opt-in envelope
already budgets both certificates in sequence, so no timeout changes.

Pinned by `tests/unit/naturalMultirunRunsAfterBaselineFailure.test.ts`.
