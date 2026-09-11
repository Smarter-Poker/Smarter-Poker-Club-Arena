# Equity lifecycle fixtures use a deterministic CPU budget

The full engine release check failed two fake-worker lifecycle cases on a runner
whose CPU reservation permits only one equity worker. Both cases request two
workers and then address the second worker directly. The same tests pass on a
larger developer machine, concealing their dependency on host capacity.

The lifecycle suite now supplies four simulated execution contexts through its
`node:os` fixture. The unchanged production reservation leaves two worker slots,
so both multi-worker scenarios execute on every runner. All assertions remain
intact. Production pool sizing and the separate capacity guard remain unchanged.

Verification: simulating two execution contexts reproduces both CI failures at
the same second-worker access. The corrected fixture exercises the existing
expired-queue and bounded-recovery assertions without skipping either case.
