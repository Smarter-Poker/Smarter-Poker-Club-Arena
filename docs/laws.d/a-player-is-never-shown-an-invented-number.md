# tests/a-player-is-never-shown-an-invented-number.law.test.ts

No file under src/components or src/pages calls Math.random() unless it is on
the test's allowlist with a non-data reason (animation, identifier, jitter,
user-requested pick), no render surface carries a mock/sample/fake data
generator or constant, SessionAnalytics is fed by SessionStatsService alone,
and SessionReplay (the second generator) stays deleted. Written after audit
CL-1: the at-table Detailed Analytics panel showed five invented figures as the
player's own session record.
