# Unresolved tournament custody retains its lease evidence

The existing hourly lease reaper could delete an expired tournament lease while its original hand or seat move was still unresolved. The database owner now keeps leases associated with reserved hands, unfinished movement operations, and incomplete manager custody transfers. Unrelated expired leases still expire under the existing age policy.

The reaper locks an eligible lease before rechecking custody and skips admitted work rather than waiting with an older snapshot. Table leases associated with the same retained tournament custody receive the same protection. No new background task was added, and no missing historical lease is recreated.

Native PostgreSQL qualification reproduces the old deletion, checks each retained and completed boundary, covers a concurrent admitted reservation, and verifies unchanged player, financial and F06 rows. The existing GameServer callback is exercised directly and the required F06 native runner includes this qualification.
