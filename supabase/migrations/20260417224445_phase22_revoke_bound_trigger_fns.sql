-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417224445 "phase22_revoke_bound_trigger_fns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 32b81f5f07007addccb7405f6930b9c0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Revoke anon/authenticated EXECUTE from bound trigger fns
--  -----------------------------------------------------------------------
--  Scope: 32 SECURITY DEFINER functions that are
--    (a) RETURNS trigger
--    (b) currently bound to at least one trigger in pg_trigger
--    (c) reference NEW/OLD/TG_* in their body (proving direct calls fail)
--
--  Why safe:
--    1. Trigger firing uses table ownership, not EXECUTE grants. Revoking
--       anon/authenticated EXECUTE cannot prevent the trigger from firing.
--    2. Direct invocation from user code would fail on NEW/OLD access,
--       so no legitimate code path should be calling these via .rpc().
--    3. service_role retained for any admin/maintenance tooling.
--
--  Why limited to 32 instead of all 42:
--    - 10 are RETURNS trigger but NOT currently bound to any trigger. They
--      could be orphans from dropped triggers. Leaving untouched so Dan
--      can audit — may be intentional dormant defense (like the
--      fn_prevent_xp_* guards) or candidates for outright DROP.
--
--  Zero-behavior-risk migration. Reversible by:
--    GRANT EXECUTE ON FUNCTION public.<name>() TO anon, authenticated;
-- =========================================================================

DO $rev$
DECLARE
    r RECORD;
    v_revoked_count int := 0;
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
          JOIN (SELECT DISTINCT tgfoid FROM pg_trigger WHERE NOT tgisinternal) tb
            ON tb.tgfoid = p.oid
         WHERE n.nspname = 'public'
           AND p.prorettype = 'trigger'::regtype
           AND pg_get_functiondef(p.oid) ~* '\mnew\.|old\.|tg_op|tg_when|tg_level'
    LOOP
        EXECUTE format(
            'REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated',
            r.proname, r.args
        );
        v_revoked_count := v_revoked_count + 1;
    END LOOP;

    RAISE NOTICE 'Phase 22: revoked anon/authenticated EXECUTE on % bound trigger functions', v_revoked_count;
END;
$rev$;

-- Mark resolved in audit
UPDATE public.phase22_secdef_grant_audit a
   SET resolved_at = NOW(),
       resolution  = 'Phase 22: Revoked anon/authenticated/PUBLIC EXECUTE. Function is RETURNS trigger, bound in pg_trigger, and references NEW/OLD — direct invocation would fail. service_role retained.'
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN (SELECT DISTINCT tgfoid FROM pg_trigger WHERE NOT tgisinternal) tb
    ON tb.tgfoid = p.oid
 WHERE n.nspname = 'public'
   AND p.prorettype = 'trigger'::regtype
   AND pg_get_functiondef(p.oid) ~* '\mnew\.|old\.|tg_op|tg_when|tg_level'
   AND a.function_name = p.proname
   AND a.is_trigger_function = true
   AND a.safe_to_revoke_anon = true
   AND a.resolved_at IS NULL;
