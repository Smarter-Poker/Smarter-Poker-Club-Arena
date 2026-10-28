# V31 sealing uses its intended RPC budget

A real106-cell build completed212 independent source artifacts and all cells, then its complete-corpus seal was cancelled by the generic service-role8-second limit. The maintained gateway already grants sealing270seconds, but the database function declared no matching RPC budget.

The forward migration pins the reviewed seal preimage and changes only its function settings: statement_timeout240seconds and lock_timeout1second. PostgREST hoists the per-RPC timeout before executing the query. The short lock budget refuses contention promptly. Function body, quality thresholds, source and approval checks, ownership, ACL, SECURITY DEFINER, search path and the global8-second role budget remain unchanged. Promotion is untouched.

The existing PostgreSQL17 certification harness applies the migration with metadata regression checks, then executes its unchanged valid-seal and invalid-source/heldout refusals. The metadata check compares the exact source body, privileges, role settings and promotion definition before/after. Installation and real corpus qualification remain separate operations; a larger execution budget does not certify the data.
