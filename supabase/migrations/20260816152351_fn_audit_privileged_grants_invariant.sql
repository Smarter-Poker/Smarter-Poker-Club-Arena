-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260816152351 "fn_audit_privileged_grants_invariant"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 27438e5fa8b3d9291721f2b441f65024 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- INVARIANT: no privileged/money function may be executable by `anon`
-- ═══════════════════════════════════════════════════════════════════════════
-- Postgres grants EXECUTE to PUBLIC on every new function, and this project's
-- default privileges also grant `anon`. So a privileged function is wide open
-- the moment it is created unless the migration explicitly revokes. That was
-- missed THREE times in one session (fn_get_or_create_conversation,
-- fn_admin_remove_player_chips, credit_club_rake_to_treasury) -- documentation
-- alone did not prevent it.
--
-- This makes the rule checkable instead of remembered. It returns one row per
-- violation and is safe to run anywhere (read-only, no side effects), so it can
-- back a CI gate, a cron alert, or a manual audit.
--
-- Usage:
--   SELECT * FROM fn_audit_privileged_grants();          -- violations only
--   SELECT count(*) = 0 AS clean FROM fn_audit_privileged_grants();

CREATE OR REPLACE FUNCTION public.fn_audit_privileged_grants()
RETURNS TABLE(
  function_name text,
  arguments     text,
  security_definer boolean,
  anon_can_execute boolean,
  authenticated_can_execute boolean,
  issue text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    p.proname::text,
    pg_get_function_identity_arguments(p.oid)::text,
    p.prosecdef,
    has_function_privilege('anon', p.oid, 'EXECUTE'),
    has_function_privilege('authenticated', p.oid, 'EXECUTE'),
    CASE
      WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
        THEN 'anon can EXECUTE a privileged/money function -- add REVOKE ... FROM PUBLIC, anon'
      ELSE 'ok'
    END::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    -- Money / privileged surface. Deliberately broad: a false positive costs one
    -- explicit REVOKE, a false negative costs an open money endpoint.
    AND (
         p.proname ~* '(mint|chip|wallet|promo|cashout|diamond|rake|bounty|settle|payout|clawback|purchase|treasury|jackpot|bbj)'
      OR p.proname ~* '^(credit|debit|transfer|distribute|deduct|atomic|admin)_'
      OR p.proname ~* '_(credit|debit|transfer|distribute|deduct)$'
      OR p.proname ~* '(promote_member|transfer_club_ownership|remove_player)'
    )
    -- Exclude read-only reporting helpers that are meant to be public.
    AND p.proname NOT IN ('fn_audit_privileged_grants')
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ORDER BY p.proname;
$function$;

COMMENT ON FUNCTION public.fn_audit_privileged_grants() IS
  'INVARIANT CHECK: returns every money/privileged function that anon can EXECUTE. Must return ZERO rows. New functions inherit EXECUTE for PUBLIC, so every privileged CREATE FUNCTION needs a paired REVOKE ... FROM PUBLIC, anon in the same migration.';

REVOKE EXECUTE ON FUNCTION public.fn_audit_privileged_grants() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_audit_privileged_grants() TO authenticated, service_role;
