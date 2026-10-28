# Cash refusal pointer batch

A production rollback profile measured 182.276 seconds walking 37,527 blocked work pointers through random receipt primary-key heap lookups. The existing receipt cover was valid and 99.96% of receipt heap pages were all-visible; another index or vacuum was not justified.

The original refusal function now gathers distinct non-null receipt IDs once, reads those IDs through the existing compact cover with one scalar-array lookup, and rejoins every original blocked pointer before fetching refusal details. The exact scope, date, null, multiplicity and output semantics remain unchanged. No accounting data, budgets, permissions, source pins or financial guards change.

The exact candidate completed a bounded production read-only rollback test in 48,385.115 milliseconds. This demonstrates this refusal-query improvement, not completed payouts or full automatic 4 AM capacity. Native PG17 compares the actual old/new whole owner across generic/custom plans, 6,000 records, duplicate/missing/null pointers and date/scope cases, preserves immutable receipt/work fingerprints and metadata, verifies empty work, and exercises frozen, ACL/preimage, rollback, replay and invalid-input refusals. The maintained weekly-refusal workflow runs this proof.
