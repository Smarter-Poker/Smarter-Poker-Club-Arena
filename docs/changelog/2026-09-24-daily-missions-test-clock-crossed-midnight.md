# 2026-09-24 - The Daily Missions recovery test read the host clock and crossed midnight

## What failed

CI run 36075088647 ("Client Unit Tests shard 2", PR #5218, which touched no
client code) failed
`tests/daily-mission-subscription-recovery.test.tsx > never issues a periodic
repair request while the tab stays open` with `mocks.dashboard` called 3 times
instead of 1 after `settle(10 * 60_000)`.

## Cause

Not cross-file pollution and not a repair timer. The page owns exactly one
clock event: `useDailyMissionDashboard` schedules a silent dashboard read at the
UTC daily reset (`scheduleRollover`, `src/components/challenges/dashboard/useDailyMissionDashboard.ts`).
The test faked `Date` without pinning it, so the fake clock started at the CI
host's wall clock. Started at about 23:56 UTC, the 10-minute advance crossed
00:00 UTC and the rollover fired - legitimate product behaviour.

The extra reads after that came from the fixture, not the product: the mocked
dashboard is minted once in `beforeEach`, so its `syncedAt` never moves.
`installDashboardProjection` derives `serverClockOffset = syncedAt - Date.now()`,
which drifts further negative on every reply, so the page's server clock stays
at the fixture's minted instant (before midnight) and re-arms the rollover
every (midnight - start) interval. A real server stamps `syncedAt` with its own
`now()`, so production re-arms for the next day.

Reproduced deterministically by shifting the process clock with a
`--require` preload: start 23:52 -> 2 calls, 23:55:45 -> 3 calls (the CI
failure), 23:58 -> 6 calls; 12:00 and 23:59:59 pass.

## Fix

Both describe blocks now fake `Date` and pin it to midday UTC, so no advance in
the file can reach a reset. A new test pins the rollover itself: started at
23:55:45 with a receipt minted when served, a 10-minute advance reads the
dashboard exactly once more and never again.
