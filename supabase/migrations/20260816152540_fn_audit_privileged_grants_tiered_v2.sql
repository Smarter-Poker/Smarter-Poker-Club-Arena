-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260816152540 "fn_audit_privileged_grants_tiered_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9099904865cd48268dff65e583ed67f7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DROP FUNCTION IF EXISTS public.fn_audit_privileged_grants();

CREATE FUNCTION public.fn_audit_privileged_grants()
RETURNS TABLE(
  severity text,
  function_name text,
  arguments text,
  security_definer boolean,
  remedy text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    CASE
      WHEN pg_get_function_result(p.oid) = 'trigger' THEN 'LOW'
      WHEN p.prosecdef THEN 'CRITICAL'
      ELSE 'MEDIUM'
    END::text AS severity,
    p.proname::text,
    pg_get_function_identity_arguments(p.oid)::text,
    p.prosecdef,
    CASE
      WHEN pg_get_function_result(p.oid) = 'trigger'
        THEN 'Trigger function; anon cannot meaningfully invoke it. Tidy up when convenient.'
      WHEN p.prosecdef
        THEN 'SECURITY DEFINER bypasses RLS and anon can call it. REVOKE EXECUTE ... FROM PUBLIC, anon NOW.'
      ELSE 'anon can call it; RLS on the underlying tables is the only thing stopping a write. REVOKE for defence in depth.'
    END::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    AND p.proname !~ '^st_'
    AND p.proname <> 'fn_audit_privileged_grants'
    AND (
         p.proname ~* '(mint_|_mint|chip|wallet|promo|cashout|diamond|rake|bounty|settle|payout|clawback|purchase|treasury|jackpot|bbj)'
      OR p.proname ~* '^(credit|debit|transfer|distribute|deduct|atomic|admin)_'
      OR p.proname ~* '(promote_member|transfer_club_ownership|remove_player)'
    )
  ORDER BY
    CASE WHEN pg_get_function_result(p.oid)='trigger' THEN 3
         WHEN p.prosecdef THEN 1 ELSE 2 END,
    p.proname;
$function$;

COMMENT ON FUNCTION public.fn_audit_privileged_grants() IS
  'INVARIANT: money/privileged functions must not be anon-executable. CRITICAL (SECURITY DEFINER + anon) must always be 0 -- gate CI on it. MEDIUM = anon but RLS-protected. LOW = trigger functions. New functions inherit EXECUTE for PUBLIC, so every privileged CREATE FUNCTION needs a paired REVOKE ... FROM PUBLIC, anon in the SAME migration.';

REVOKE EXECUTE ON FUNCTION public.fn_audit_privileged_grants() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_audit_privileged_grants() TO authenticated, service_role;
