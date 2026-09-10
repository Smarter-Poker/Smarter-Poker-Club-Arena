# tests/a-sweep-that-cannot-afford-its-first-mutation.law.test.ts

The elimination sweep's work budget may bound how much a sweep does; it may
never stop a sweep doing anything at all. A bust pass that reaches its
mutations having committed nothing extends its deadline once, by
SWEEP_MUTATION_GRACE_MS, only in that pass, and reports the extension with the
backlog that caused it; once it has committed a finish, or has already had its
one grace, it yields and requeues as before. The grace flag is cleared with the
deadline it extends. And a manager requests one elimination sweep when it
adopts an event, on start and on resume, after registering the scheduler:
registration only makes it wakeable, and the routine wake is a hand completing
with a zero stack, which an event whose tables cannot deal will never produce.
