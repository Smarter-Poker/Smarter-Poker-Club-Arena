# Lightning Access Cleanup Awaits RPC Builders

The private access witness called `.catch()` on a Supabase RPC builder in cleanup. That builder is thenable, so cleanup threw, masked the original observation failure and skipped synthetic local signout. Await the original operation inside an exception boundary and always retain the sanitized report and local session cleanup.

An interrupted operation may recover only its exact persisted zero-balance pending request, matching composite membership identity and the full joined timestamp. It cancels through the normal authenticated door, verifies absence and reports cleanup only. A fresh explicit operation is required for a new access proof; cached join receipts are never promoted into recreated membership. Changed, funded or unowned rows remain untouched.

The actual hosted failure is retained. Then-only builder and owned-pending boundary regressions pass; actual corrected access remains pending protected delivery. The failed run's one lost synthetic session was separately revoked by guarded exact database cleanup, never reported as API signout.
