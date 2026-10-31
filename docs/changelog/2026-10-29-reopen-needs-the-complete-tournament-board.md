# Reopening a tournament table requires its complete board

GameServer.reopenTablesClosedUnderLiveTournaments reads a single capped table response for each 100-event chunk. An open sibling beyond row 1000 is invisible, so the planner reopens a closed table despite its explicit rule to leave any event with an open table alone. The same method continues to write after its captured server lifecycle changes during the inventory read. Two actual-method regressions fail before the correction.

Read the live event board and each table chunk completely by stable ID. Keep the existing bounded seat chunks, reject unreadable seat responses, and require the original lifecycle and unfrozen state through inventory and before every write. Preserve the existing planner, retirement custody and conditional closed-table update. This is not attributed to today's original-hand outage and adds no repair timer.

Verification: both original regressions fail on the prior implementation. Six actual-method cases pass, including a successful conditional reopen, unreadable suffixes and lifecycle withdrawal. The connected recovery/source suites and root/server TypeScript checks pass. Normal push, hosted qualification, protected merge and live engine proof remain pending.
