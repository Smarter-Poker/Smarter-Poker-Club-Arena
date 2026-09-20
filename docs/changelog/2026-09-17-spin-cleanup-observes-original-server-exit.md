# Observe the original Spin qualification shutdown

The funded Spin cancellation/refund check in PR4808 run35278213171 completed its
financial, replay and fresh-state assertions but failed its single server-cleanup
snapshot immediately after all four psql clients exited. The same complete staged
source inputs passed in run35277623546. The failed snapshot counts were not retained,
so that run does not establish which backend or lock remained at the observation.

The existing cleanup owner now records every observation and waits for the original
server connections and locks to disappear within its unchanged five-second budget.
All original client exits and exact zero backend/lock counts remain mandatory.
Expiry, cancellation and refund calls are never repeated by this observation.
Malformed or failed reads, failed evidence writes, lingering resources and an
expired deadline still fail. The outer owner must independently prove allocation
disposal as before.

The retained delayed-backend regression failed the old single-snapshot behavior.
The existing wrapper source-control entry passed 62 tests with the repair. These
are source/protocol controls; the changed candidate's protected Linux PostgreSQL17
execution remains separate and is not claimed by that result.
