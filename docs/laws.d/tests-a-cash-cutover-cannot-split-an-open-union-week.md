# tests/a-cash-cutover-cannot-split-an-open-union-week.law.test.ts

A cutover may not be armed over a period that is already open. This is the
second instance of the bug 20260918064540 fixed: one operation on 2026-09-17
armed two cutovers 1.8 seconds apart, the tournament fee cutover stranded 649
live tournaments, and the cash accrual cutover landed 83.4 hours into an open
union week. Because `fn_accounting_union_earned_plan` refuses any period
beginning before the cutover as uncertified, the hourly union-integrity-sweep's
two money controls, `fn_union_rake_basis_refresh` and
`fn_union_enforce_stop_loss`, failed every hour for fourteen hours, and the
union stop-loss went unenforced for all of it with no trace but two `warning`
rows an hour. `20260918091617` adds
`fn_ca_cash_cutover_week_split_by(timestamptz)` and the BEFORE INSERT trigger
`ca_cash_cutover_is_week_aligned`, which refuses any instant that splits a union
week. This pins the trigger to INSERT and nothing wider, because
`accounting_cash_cutover_immutable` and its no-truncate sibling already hold
every other operation and a precondition asserts that pair is still all there
is; the two md5 pins on the week definition and on the refuser whose rule the
guard encodes; STABLE rather than IMMUTABLE on the observer, since it resolves
America/Los_Angeles and a timezone update can move a boundary; both REVOKEs; the
finite-instant check happening before any week arithmetic; that the refusal
names the week, the orphaned hours, the instant to use instead and the
stop-loss consequence; every postcondition proof including that the refusal is
read back and matched so the test cannot pass on a primary key violation; and
that the rollback drops the guard but never the cutover row, since with no row
every period is uncertified and that is worse than the bug.
