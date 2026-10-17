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

## Club Data reads stop retrying after the page unmounts

Getting this change through CI exposed a real defect behind a flaky test
(`club-data-page-renders` "aborts a protected request when its response
deadline expires", red on PRs #7281, #7282 and #7283). `coldRead` in
`ClubDataPage.tsx` gave each read up to four 12-second attempts but never told
`retryFetch` when the page was gone, so after an operator left Club Data a
timed-out read kept sending up to three more full-window snapshot scans to the
database. In the test file, the previous test's leftover ladder fired into the
next test's mock and added an extra request.

`coldRead` now requires a mounted ref (set and cleared beside `cancelledRef`)
and passes it to `retryFetch`, which already stops a ladder whose page has
unmounted. Every caller already discarded a result once the page was gone, so
nothing a player sees changes. The new test "stops retrying a timed-out read
once the page has unmounted" saw 4 snapshot calls after unmount before the fix
and 1 after; the file passed 15 of 15 consecutive runs (it failed about one
run in five before).
