-- ═══════════════════════════════════════════════════════════════════════════
--  THE FREEZE GUARD RESOLVES NAMES ON A PINNED PATH
-- ═══════════════════════════════════════════════════════════════════════════
-- Supabase advisor pass after the freeze shipped: three of the new functions
-- were created without SET search_path, so they resolve referenced objects on
-- the CALLER's search_path. For fn_refuse_while_frozen that caller is any
-- role writing the seven guarded money tables, and the names it resolves
-- (engine_maintenance_break, fn_freeze_bypass_active) are the freeze itself.
-- No browser role can create schemas here, so this is hardening rather than
-- an open hole - but a guard that decides whether money moves should not let
-- its caller choose where its names come from.
--
-- One transaction; ALTER FUNCTION ... SET does not change bodies or grants.

BEGIN;

ALTER FUNCTION public.fn_refuse_while_frozen() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_freeze_bypass_active() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_db_now() SET search_path = public, pg_temp;

COMMIT;
