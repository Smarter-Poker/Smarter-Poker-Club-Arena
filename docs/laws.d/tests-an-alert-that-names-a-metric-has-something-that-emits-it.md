# tests/an-alert-that-names-a-metric-has-something-that-emits-it.law.test.ts

Prometheus does not enforce that a rule's metric exists and cannot warn about
it. `poker_settlement_failure_rate > 0.02` against a name that has never had a
sample evaluates to an EMPTY VECTOR, which is indistinguishable from a
condition that is false: the rule loads, reads green on every dashboard, and
can never fire. This estate has been bitten three times - 27 rules in August,
`poker_hands_total` on a flag-gated registry that left SLOHandsAreNotBeingDealt
(critical, sms) unfirable, and fifteen rules written against thirteen names
with no producer at all. The last was found seven days late with four of the
conditions it describes already true: 73 undeclared triggers on money tables,
693 unread critical money alerts, 16 silent cron jobs, one of them silent for
13.7 days, and two of the four an SMS page.

scripts/ci/check-monitoring-drift.mjs enforces the rule in CI. This law pins
the enforcement itself: that the check exists, that it is wired into the CI job
running the other monitoring guards, and that it still fails when a producer is
taken away. A guard nobody can prove still bites is the same shape of problem
as the rules it guards.
