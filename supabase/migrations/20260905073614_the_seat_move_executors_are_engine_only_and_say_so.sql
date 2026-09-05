-- 20260905073614_the_seat_move_executors_are_engine_only_and_say_so.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20260905064237 re-declared fn_cash_seat_move_execute and
-- fn_cash_seat_swap_execute (CREATE OR REPLACE, SECURITY DEFINER, both write
-- seats) without writing a GRANT or REVOKE for either. On production that was
-- harmless: CREATE OR REPLACE keeps the ACL the function already had, and the
-- earlier declaration had already revoked PUBLIC/anon/authenticated. Verified
-- 2026-09-05 02:36 CDT: has_function_privilege('authenticated', ...) is false
-- for both, only service_role and postgres hold EXECUTE.
--
-- On a fresh database the file alone would leave both open to every browser
-- (a new function's default ACL grants EXECUTE to PUBLIC), which is what
-- scripts/ci/check-definer-authorization.mjs refused. Both are called only by
-- the engine (server/src/services/supabase/seatMoves.ts) and by SQL inside the
-- cluster tick; nobody in a browser calls them, and neither derives an actor
-- from auth.uid() because the actor is the move row, planned by the tick.
--
-- So the migration files now say what production already does. Pure
-- GRANT/REVOKE: not in pgrst_ddl_watch, so no schema-cache reload.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_cash_seat_move_execute(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_execute(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_cash_seat_swap_execute(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_swap_execute(uuid) TO service_role;

COMMIT;
