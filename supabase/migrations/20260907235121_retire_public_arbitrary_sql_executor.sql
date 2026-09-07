-- 20260907235121_retire_public_arbitrary_sql_executor.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
-- The repository exposed a service-role callable `exec_sql(text)` endpoint and
-- shipped a client that accepted an arbitrary inline query. That bypasses the
-- reviewed migration ledger and makes it impossible to prove which schema a
-- release actually installed. Production currently has exactly the text
-- overload below. Remove it atomically; all future DDL is a named migration.

BEGIN;

DROP FUNCTION IF EXISTS public.exec_sql(text);

COMMIT;
