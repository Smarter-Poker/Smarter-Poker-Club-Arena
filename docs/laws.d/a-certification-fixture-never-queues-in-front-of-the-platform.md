# tests/a-certification-fixture-never-queues-in-front-of-the-platform.law.test.ts

A production certification fixture never queues in front of the platform's
purchases. Advisory lock (530090,1) is the entry and maintenance gate: every
buy-in, add-on, rebuy, registration, seat acquisition, launch and blind publish
takes it shared. Four welcome-certification fixtures took it exclusively with
`pg_advisory_xact_lock`, and a waiting exclusive request makes every later
shared request queue behind it, so each fixture wait stalled every purchase on
the platform (79 waits of 1 s or more, up to 7.6 s, in the 24 h to 00:30 UTC
2026-10-04). They now poll `pg_try_advisory_xact_lock` every 50 ms for up to
30 s, which never joins the queue, hold the gate exclusively to the end of
their transaction once they have it, and refuse with
`CERTIFICATION_FIXTURE_GATE_BUSY` (55P03) otherwise. The maintenance break
functions keep queueing, because they must not be starved. The law pins the
exact fragment, the four md5-pinned fixtures and nothing else, and the bound;
the CI harness proves the defect on the pre-image, the next purchase taking the
gate at once afterwards, the fixture still holding it to its commit, and the
30 s refusal.
