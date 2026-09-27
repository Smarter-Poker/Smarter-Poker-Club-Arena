-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417224830 "phase22_revoke_orphan_trigger_fns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 daa0e69a247f4779bcbad023786319fe of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Revoke anon/authenticated EXECUTE from 10 orphaned trigger fns
--  -----------------------------------------------------------------------
--  Scope: RETURNS trigger functions that are NOT currently bound to any
--  trigger in pg_trigger.
--
--  Why safe:
--    1. Zero trigger firing path (nothing references them in pg_trigger)
--    2. Each references NEW/OLD/TG_OP internally → direct .rpc() call would
--       fail at that access point
--    3. fn_prevent_xp_deletion is a pure RAISE EXCEPTION body (impossible
--       to exploit regardless of caller)
--    4. service_role retained in case Dan wants to rebind them as triggers
--       later (trigger re-binding via CREATE TRIGGER does NOT require
--       EXECUTE grant on the function — table owner permissions suffice)
--
--  Context:
--    - create_user_progress_on_signup / create_user_wallets — appear to be
--      legacy alternatives to handle_new_user (currently the bound signup trigger)
--    - fn_sync_club_member_count — superseded by currently-bound sync trigger
--    - update_profile_vip_status — superseded by fn_sync_profile_vip_status
--    - XP lock guards (fn_prevent_xp_*, prevent_xp_loss) — likely detached
--      when XP table structure changed
--
--  Kept (not dropped) so Dan can re-attach if needed. Drop decision is a
--  separate review.
-- =========================================================================

DO $rev$
DECLARE
    r RECORD;
    v_revoked int := 0;
BEGIN
    FOR r IN
        SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN public.phase22_secdef_grant_audit a 
            ON a.function_name = p.proname
           AND a.is_trigger_function = true
           AND a.safe_to_revoke_anon = true
           AND a.resolved_at IS NULL
         WHERE n.nspname = 'public'
           AND p.prorettype = 'trigger'::regtype
           AND p.oid NOT IN (SELECT DISTINCT tgfoid FROM pg_trigger WHERE NOT tgisinternal)
    LOOP
        EXECUTE format(
            'REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated',
            r.proname, r.args
        );
        v_revoked := v_revoked + 1;
    END LOOP;

    RAISE NOTICE 'Phase 22: revoked anon/authenticated EXECUTE on % orphaned trigger functions', v_revoked;
END;
$rev$;

-- Mark resolved in audit
UPDATE public.phase22_secdef_grant_audit a
   SET resolved_at = NOW(),
       resolution  = 'Phase 22: Revoked anon/authenticated/PUBLIC EXECUTE. Function is RETURNS trigger but currently not bound to any pg_trigger (orphaned). Body references NEW/OLD/TG_OP so direct call would fail. service_role retained for potential trigger re-binding.'
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.prorettype = 'trigger'::regtype
   AND p.oid NOT IN (SELECT DISTINCT tgfoid FROM pg_trigger WHERE NOT tgisinternal)
   AND a.function_name = p.proname
   AND a.is_trigger_function = true
   AND a.safe_to_revoke_anon = true
   AND a.resolved_at IS NULL;
