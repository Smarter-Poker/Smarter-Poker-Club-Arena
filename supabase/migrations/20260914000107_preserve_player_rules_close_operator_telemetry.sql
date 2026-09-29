-- Reserved 2026-09-14 00:01:07 UTC. Release telemetry verification found
-- five operator diagnostics callable by player roles, plus the intentionally
-- player-facing jackpot rule reader without an explicit request check.
-- Audited live RLS dependencies: zero for all six. The diagnostics' only
-- routine callers are service-only SECURITY DEFINER sweep/notification jobs.
-- Preserve their bodies and service access; close player access. Preserve
-- the public rule projection and authenticated UI by checking account/service
-- identity inside that reader. No allowlist exemption or detector bypass.
BEGIN;
SET LOCAL lock_timeout='2s';
REVOKE ALL ON FUNCTION public.fn_ca_knockout_door_stalled(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_orphaned_running_tournaments(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_rake_rollup_writer_silent(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_stranded_completing_tournaments(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_tables_that_cannot_deal(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_knockout_door_stalled(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_orphaned_running_tournaments(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_rollup_writer_silent(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_stranded_completing_tournaments(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tables_that_cannot_deal(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bbj_allocation_policy()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
AS $function$
  -- These are the allocator's public rates, not pool balances or diagnostics.
  -- Service transport has no user subject; a player must have a real subject.
  SELECT jsonb_build_object(
    'pivot_threshold',p.pivot_threshold,
    'standard_main',p.standard_main,
    'standard_backup',p.standard_backup,
    'standard_promo',round(1-p.standard_main-p.standard_backup,4),
    'pivot_main',p.pivot_main,
    'pivot_backup',p.pivot_backup,
    'pivot_promo',round(1-p.pivot_main-p.pivot_backup,4))
  FROM public.ca_bbj_policy p
  WHERE p.id=1 AND (auth.role()='service_role' OR auth.uid() IS NOT NULL);
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_allocation_policy() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_bbj_allocation_policy() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_allocation_policy() TO service_role;
COMMENT ON FUNCTION public.fn_bbj_allocation_policy() IS
  'Authenticated players and service requests read the allocator public rule rates from row1. Promo remains the derived remainder; no balances, account data or operator diagnostic is exposed. A role without an account subject returns no policy.';
COMMIT;
