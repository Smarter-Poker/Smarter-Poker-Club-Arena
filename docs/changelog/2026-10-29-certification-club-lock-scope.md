# Certification cleanup must not stop live hands

PostgreSQL logs on October 29 at 19:13:47 UTC named PID 4068188 as the holder of global advisory lock (530090,1). Its stack was the welcome certification retirement chain. Thirty-six live continuation writes timed out during that hold. The prior nonqueueing admission fixed waiting-writer starvation but retained this exclusive hold across all cleanup work.

Four private preparation functions now take shared maintenance admission and lock only their club row FOR UPDATE NOWAIT before reading its identity. The installed retired-club mutation trigger already takes FOR KEY SHARE on that same parent for gameplay and cashier writes. The complete identity, lineage, active-lease, pending-hand, activity, monetary and transaction-bound delete checks remain in their original functions. Source hashes and ACLs are checked atomically by the migration.

Cash games and tournament schedules have no club foreign key. Their existing mutation guard now refuses a missing club after its parent-lock read, closing the race where cleanup deletes that parent while a writer waits. Other mutation branches retain their behavior.

The isolated PostgreSQL concurrency harness reproduced both old defects. Seventeen cases passed for the candidate, including live continuation and unrelated-club progress during cleanup, same-club exclusion, active-writer refusal, maintenance exclusion, rollback, both deleted-parent races untrusted access and the exact installer live-proof predicate. The complete welcome-package harness then passed 200 cases with the five exact current catalog definitions, the migration and installed club-write triggers, including financial/activity/custody refusals and successful retirement. No production mutations were used. Required accounting CI runs both suites.

Protected merge, exact installation/history readback and production observations remain required before this is a live fix.
