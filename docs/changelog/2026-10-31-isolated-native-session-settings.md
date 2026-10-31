# Establish native snapshot session settings explicitly

Actual run41245802556 connected through the canonical strict-TLS session pooler,
imported the original exported snapshot and completed ROLLBACK in631ms. Its exact
six-boolean result proved database/read-only/repeatable-read, but refused the
five-second statement timeout, one-second lock timeout and own application name.
No dump or connected game case ran. Startup options therefore did not establish
those requested settings; the exact provider implementation cause is unknown.

The native psql transaction now explicitly SET LOCALs those three fixed settings
before importing the original snapshot and before its first SELECT. The existing
six independent boolean checks must still all pass. This configuration is local
to the same read-only transaction and rolls back with it; no global setting,
credential, role, snapshot, timeout budget, transport or readiness gate changes.
The focused regression requires each setting exactly once after BEGIN and before
snapshot import, while retaining exact false-fact refusal and privacy checks.

Native pg_dump separately resets its startup statement_timeout and lock_timeout.
This change does not claim its PGOPTIONS is an effective per-query guard or fix
its earlier export deadline. Its actual whole-export deadline and explicit
--lock-wait-timeout=1000 remain authoritative. No repeated activity witness or
active game is used. Full-schema parity and all14 connected cases remain unproved.
