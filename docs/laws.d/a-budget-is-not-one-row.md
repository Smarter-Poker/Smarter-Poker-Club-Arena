# tests/a-budget-is-not-one-row.law.test.ts

The promotional spend was a running total on one row per engine per month, held
locked until the awarding transaction committed, and it lost 5,860 awards worth
399,948 diamonds to lock timeouts on 2026-09-08. Because the whole body sits in
one exception handler, a timeout also skipped the per-user write and BOTH DR7
rule evaluations - so with the rules armed to refuse the guard would have failed
open under exactly the load that breaks it. Spend is append-only now, reported as
the frozen baseline plus the appended rows; the per-user write goes first; a
failed write while a rule is armed is critical and says a guard did not run; and
the award is still paid, because a player never loses an earned reward to our
bookkeeping.
