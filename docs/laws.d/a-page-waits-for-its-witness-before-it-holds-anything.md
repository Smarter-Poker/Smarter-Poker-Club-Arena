# tests/a-page-waits-for-its-witness-before-it-holds-anything.law.test.ts

A page-scoped `fn_rakeback_recompute_periods` call of an open week waits, before
it takes the club-week lock or touches the request row and without writing
anything, at most 16 x 0.5 s for one unaccrued hand of its own club to exist,
then lets the unchanged 20260926091232 door and the unchanged calculator decide
(once the settler was current, a miss paid a 20-130 s full-week read that held
the lock and the request row and blocked tournament completion and live hands'
post-commit work, only to be refused). The test carries planted regressions
(unbounded wait, wait for a closed week, wait for a whole-period call, wait
under the lock, wait that writes, witness from another club, wait removed) and
each must be named by the checker.
