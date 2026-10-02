-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416020413 "bug_025_drop_shadowing_stub_overloads"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c11c6bffae64b105906952147cfe9aee of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 O: drop silent-success stub OVERLOADS that were shadowing real
-- implementations. When two functions share a name with different arity,
-- PostgREST picks the one whose parameter names match the request. A stub
-- overload with different param names can still be called accidentally.
-- Safer to remove the stubs entirely so the real overloads take every call.

-- award_bbj: the 3-param overload is a stub; the 18-param overload is real
DROP FUNCTION IF EXISTS public.award_bbj(uuid, uuid, numeric);

-- claim_reward: the 2-param overload is a stub; the 3-param overload is real
DROP FUNCTION IF EXISTS public.claim_reward(uuid, uuid);

