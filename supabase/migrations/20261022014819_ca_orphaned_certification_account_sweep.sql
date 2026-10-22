-- Owner instruction 2026-10-21: no post-deploy test account may linger in a real club.
-- A certification run that is cancelled or killed can skip its own always() cleanup,
-- and the only other recovery (cleanupStaleProductionE2EAccounts) runs inside the
-- Club Create Certification job alone. PostDeployf3622 sat as an admin in KINGS CLUB
-- and Deep Stack Society for ~2 hours that way. This adds a database-side fallback
-- that calls the SAME guarded door (cleanup_reserved_certification_account) on
-- identities older than the longest certificate that may own them (112 minutes,
-- STALE_ACCOUNT_AGE_MS in scripts/ci/production-e2e-account.mjs). Identities that
-- still own a club are left to the CI recovery, which retires template clubs first.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_ca_sweep_orphaned_certification_accounts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row record;
  v_result jsonb;
  v_done jsonb := '[]'::jsonb;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('swept', 0, 'reason', 'platform_is_frozen');
  END IF;
  FOR v_row IN
    SELECT s.id, s.email
      FROM public.fn_ca_stale_certification_accounts(now() - interval '112 minutes') s
     WHERE s.email LIKE 'ca-customization-cert-postdeploy-%@example.invalid'
       AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.owner_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM public.unions u WHERE u.owner_id = s.id)
  LOOP
    BEGIN
      v_result := public.cleanup_reserved_certification_account(v_row.id);
    EXCEPTION WHEN OTHERS THEN
      v_result := jsonb_build_object('success', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
    END;
    v_done := v_done || jsonb_build_array(jsonb_build_object('user_id', v_row.id, 'result', v_result));
  END LOOP;
  RETURN jsonb_build_object('swept', jsonb_array_length(v_done), 'accounts', v_done);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_sweep_orphaned_certification_accounts() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'ca-orphaned-certification-account-sweep',
  '12,27,42 * * * *',
  $$SELECT public.fn_ca_sweep_orphaned_certification_accounts()$$
);
