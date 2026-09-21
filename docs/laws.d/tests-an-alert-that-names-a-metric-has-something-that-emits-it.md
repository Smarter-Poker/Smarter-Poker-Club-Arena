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

SHARPENED 2026-09-21: "something that emits it" means something in the BUILD
THAT IS RUNNING, not something in this repo. The weaker reading held for four
weeks and cost eight rules across two files - six metrics merged to main and
absent from engine 8825af51, the build production was actually running, 125
commits behind. check-alert-rules-match.mjs printed all six as "HAVE A
PRODUCER, NO SERIES YET - not a failure" and signed off with "every rule reads
a real series". Two of the eight were EngineCannotBeReplaced and
PokerEngineCannotBeReplaced, written after the 65-hour outage so the next one
would page somebody, and structurally unable to fire throughout it. The check
now asks the engine's own /health.version, reads the producer at THAT commit,
and separates a counter waiting for its first event (not a failure) from a
rule ahead of the engine (fatal). A build it cannot identify is exit 2,
COULD NOT TELL, never a pass.
