# Agent Private Data And Assignments

Owner direction: sub-agents, agents and super agents have access only to their own private records and their connected downlines. They cannot see, open or spend club banks, reserves or club promotional pots. Public lobby/game metadata remains available for play.

The migration removes super-agent club-bank and unrestricted-statement authority, redacts the money-panel producer, and denies direct reads of private club financial columns. Roster rows and counts, member-record access, operational overview and private report policies follow the same boundary. Existing transaction implementations, wallet balances and financial histories are preserved. The lobby's invoker RPC selects only the public fields it actually returns; owner setup obtains its bank figure through the authorized money panel.

The Hierarchy tab now offers assignment, reassignment, selected-member transfer and moving all direct children shown for a source agent. Moving an agent keeps its subtree attached. One club agreement lock, source comparison, active-club validation, cycle/rank checks, existing commercial agreement triggers and a durable operation receipt make each transfer atomic and safely repeatable. Both membership and agent parent links change together. Only active club staff or an appropriately scoped union overseer can perform these operations; being an agent does not grant assignment authority.

Native PostgreSQL tests reproduce the prior bank, statement, roster and player-stat exposure. They verify the exact migration, real database roles/RLS, private column denial, immediate scope changes, authorization, rollback, duplicate operations, stale sources and hierarchy boundaries. UI tests cover denied controls and retrying the same operation after an unknown response. The native test is wired into the existing Data Console PostgreSQL check.

A companion World Hub change closes the service-role operations API paths that treated super agents as club admins and restricts chip-flow aggregation to the verified recursive downline.

This source note is not production completion evidence. The task checkpoint records required checks, protected integration, installation, provider publication and live proof separately.
