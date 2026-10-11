# Native rake retry qualification releases the lock deterministically

Required accounting qualification failed its exact second-attempt assertion.
The fixture released its real row lock after observing a transient 100ms retry
sleep. Scheduling could miss that first sleep or finish COMMIT afterward, so
that observation did not guarantee the assertion's prerequisite.

The release-mode fixture now catches its genuine first 55P03, records that
nontransactional observation and waits on a peer-owned advisory latch. The
peer observes the persistent acknowledgment, commits its row-lock release,
then unlocks the latch. The fixture re-raises the original error so the
unchanged production function performs its normal retry.

The exact second-attempt, one-credit and rolled-back failed-attempt assertions
remain. The original row timeout, five-second observer, ten-second session
acknowledgment and production retry limits are unchanged. Exhausted timeout,
deadlock, permanent refusal and replay checks remain in the same native suite.
No production function, migration or money is changed by this fixture repair.
Native PostgreSQL qualification and protected CI results are recorded separately.
