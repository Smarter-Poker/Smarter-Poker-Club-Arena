# Data reports stay inside the current account and downline

Club Data now checks its database scope freshly on entry. Agents opening the advanced whole-club URL return to their own downline report; players and unknown/error permissions are refused. A previous account's permission and figures are retired before another account renders, including while the next session hydrates and when old requests finish late. Union report access also binds the verdict to the current account. The Report action appears only on a response explicitly scoped to the whole club.

The database already enforces club scope for owners/co-owners/admins and downline scope for super agents, agents and subagents. Its private downline traversal now deduplicates user identities to terminate cycles without the old 20-level cutoff. The query still begins at the current caller and stays within the requested club. It changes no money or membership records.

Regression evidence: original client fails the account-switch tests; corrected client passes. Native PostgreSQL qualification covers all eight roles, exact self/deep-downline totals versus unrelated players, filtered totals, cyclic hierarchies, whole-report/union refusal, and private-helper privileges. Production delivery is recorded in CHECKPOINT-data-access-01a17a22.md.
