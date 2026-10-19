# Owner fee capture resumes inside the original tournament close

Direct-owner reassignment exposed an earning-contract defect: the producer
asked for an owner agent agreement that did not exist. The exact charge and
manifest survived in immutable legacy_unverified fee batches, without canonical
sources. The original close therefore refused its net plan, accumulated decided
games and delayed unrelated knockouts. One observed heads-up knockout waited
13m38s. At 18:11 UTC, 985 affected fee batches across 852 live/registering events
held 3959.29 in fee custody. No historical rate is changed by this correction.

PR7458 owns the direct-owner earning-contract repair. Its exact installed
postimage is a prerequisite here. This migration appends incident-bounded
capture proof alongside the old batches. The original tournament close uses
the existing producer's full debit/entitlement/registration validation and cent
allocation, re-reads the original charge-time membership/agent terms, and then
writes canonical sources plus their immutable proof in the same transaction as
the existing fee recognition and player settlement. Old batches stay intact.

The same net-plan and weekly-quality readers accept only proof matching the
entire original batch, economic fingerprint, canonical sources and conserved
amount. An unrelated missing agreement, changed owner/scope, unposted or wrong
debit, missing source, incomplete prior attempt or outside-incident fee refuses.
Only the owning close can call the private continuation. No schedule is added.

Native PostgreSQL 17 reproduces the old refusal, proves that the producer fix
alone does not repair old batches, and passes after the close correction. It
checks unchanged batches, original 10% historical terms, permission refusal,
immutable proof, duplicate/concurrent calls, malformed debit, time boundary,
wrong owner, non-completing event, rollback after a later terminal refusal and
migration replay refusal. The existing required accounting shard executes it.
The fixture uses real capture/net-plan/earning definitions and selected table
columns, with focused constraints; full live terminal and payment readback are
separate acceptance requirements after protected installation.
