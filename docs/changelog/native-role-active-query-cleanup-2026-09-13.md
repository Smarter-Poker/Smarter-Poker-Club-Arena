# Observe owned active-query and backend cleanup

Native run34780871676 completed24 role fault cases, then failed entry-active at the physical backend-absence check. The driver had closed its clients, but PostgreSQL could still be executing the deliberately active pg_sleep query. A socket close is not proof that its backend has exited.

The active fault now captures the held backend PID and exact backend-start timestamp before starting that query. Cleanup first acknowledges installer rollback, then requests cancellation only for that PID/start pair in the owned database, with the original postgres session role and client-backend type. It requires the cancellation acknowledgment and the query's cancellation SQLSTATE before closing the clients. Bounded read-only observations then wait for actual backend absence; unknown results and late observations still refuse. First-failure diagnostics and final client cleanup remain intact.

This applies only to the disposable native qualification fixture. It does not cancel production work, change any SQL role input or expected refusal, extend the existing overall deadline, or grant native qualification from portable tests.

Validation is recorded in the source receipt. New tests refuse missing/replaced target identities, unacknowledged cancellation, incorrect query outcomes, unknown absence rows and expired observation windows. An actual old-method counterexample rejects the first still-present observation; the successor accepts only after observing absence, with its observer closed in both outcomes. Fresh native execution remains required.
