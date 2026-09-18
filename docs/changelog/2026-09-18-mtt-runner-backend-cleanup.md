# 2026-09-18 — wait for owned PostgreSQL backend teardown before fixture removal

## Change

- `scripts/ci/test-mtt-unlimited.py:237` previously treated one immediate nonzero
  connection count after a terminal `psql` client as a retained-session failure.
  PR #4842 CI run `35312215136` failed this check after its charge-amount rollback
  comparison. Its original diagnostic did not retain the backend identity.
- A private PostgreSQL 17 reproduction proved the race: the successful client
  exited while its own backend still held 3,003 locks during temporary-object
  teardown, then naturally reached zero locks and zero backends. The original
  runner refused this legitimate exit sequence.
- Database disposal now observes fresh autocommit backend and database-lock
  counts within the unchanged runner deadline and records each observation.
  Both counts must be exactly zero before the existing ordinary drop and database
  absence check. Retained work, invalid observations and expired deadlines still
  fail; no backend termination, forced drop or deadline extension was added.
- The activation source manifest pins the changed runner bytes. No financial
  authority, migration, engine behavior or Spin fixture changed.

## Validation

- Existing runner suite: 34 tests passed, including five directly triggered
  cleanup regressions. The new tests failed against the original implementation.
- Private PostgreSQL 17 reproduction: original runner failed; candidate observed
  the same 3,003-lock exit sequence reach zero naturally and removed its database.
- Repository source contracts: 413 tests passed. Root TypeScript compilation
  passed. Changed files were re-read.
- Full private PostgreSQL 17 preparation passed 11 native probes and 14 races;
  activation passed 4 native probes and 14 races. Both original clusters were
  stopped and removed. Results are retained with the assigned delivery evidence;
  production publication remains the owning task's separate protected delivery
  step.
