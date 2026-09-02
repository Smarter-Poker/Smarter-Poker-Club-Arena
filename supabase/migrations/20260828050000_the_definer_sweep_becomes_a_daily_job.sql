-- ═══════════════════════════════════════════════════════════════════════════
--  THE SWEEP THAT FOUND NINETEEN, REPEATED EVERY DAY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Applied to production 2026-08-28 via the Supabase MCP (apply_migration
-- "fn_definer_exposure_audit_repeats_the_sweep_daily" and
-- "revoke_the_twentieth_and_twenty_first"). This file is the record of why.
--
-- A hand-written query on 2026-08-27 found 19 SECURITY DEFINER functions that
-- WRITE, that a browser role could execute, and that never referenced
-- auth.uid(), auth.role() or auth.jwt() - so they could not know who was
-- calling. One let an ordinary member rewrite a club's member_count from 592 to
-- 10,591. Another pays chips.
--
-- scripts/ci/check-definer-authorization.mjs stops a new one arriving through a
-- MIGRATION IN THIS REPOSITORY. It cannot see the live database, and this estate
-- applies schema straight to production through the Supabase MCP. That is not an
-- edge case, it is the normal path, and it is how all three of the most recent
-- ones arrived.
--
-- THE FIRST RUN OF THIS AUDIT, four hours after the original sweep, returned two
-- functions that did not exist when that sweep ran:
--
--   fn_backpay_spin_unpaid_winners(boolean, integer)   back-pays Spin winners
--   fn_requeue_unbanked_fees(boolean, integer)         requeues unbanked fees
--
-- Both SECURITY DEFINER, both holding EXECUTE for `authenticated`, both write,
-- neither consults the request, and neither has a caller in any of the seven
-- repositories. They are revoked below. That is the argument for the auditor,
-- made by the auditor, on day one.
--
-- AFTER, the live answer is exactly the two functions that were read line by
-- line and deliberately kept, which is the committed baseline:
--
--   get_current_settlement_period    no arguments, nothing to aim
--   recalculate_leaderboard_ranks    idempotent recompute, moves no money
--
-- THE AUDITOR READS NOTHING BUT THE CATALOG and writes nothing at all. An
-- auditor that can change what it audits is not an auditor.
--
-- Its predicate is deliberately identical to the CI gate's, in the same words,
-- so the two cannot drift into disagreeing about what is dangerous.

CREATE OR REPLACE FUNCTION public.fn_definer_exposure_audit()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(x.entry ORDER BY x.entry->>'function'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
             'function', p.proname,
             'args', pg_get_function_identity_arguments(p.oid),
             'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
             'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE')
           ) AS entry
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.prorettype <> 'pg_catalog.trigger'::regtype
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR has_function_privilege('anon', p.oid, 'EXECUTE'))
       AND pg_get_functiondef(p.oid) ~* '(^|[^a-z_])(insert into|update |delete from)'
       AND pg_get_functiondef(p.oid) !~ 'auth\.uid\(\)|auth\.role\(\)|auth\.jwt\(\)'
  ) x;
$function$;

REVOKE ALL ON FUNCTION public.fn_definer_exposure_audit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_definer_exposure_audit() TO service_role;

COMMENT ON FUNCTION public.fn_definer_exposure_audit() IS
  'Every SECURITY DEFINER function a browser role can execute that writes and never consults the request identity. Read-only. Run daily by scripts/ci/audit-live-definer-exposure.mjs against a committed baseline. service_role only.';

-- ── AND THE TWO IT FOUND ────────────────────────────────────────────────────
DO $$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.fn_backpay_spin_unpaid_winners(boolean, integer)',
    'public.fn_requeue_unbanked_fees(boolean, integer)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END $$;

-- Proof, in the migration, that the revoke took and the engine kept its access.
DO $$
DECLARE r record; bad text := '';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS browser,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS engine
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_backpay_spin_unpaid_winners','fn_requeue_unbanked_fees')
  LOOP
    IF r.browser OR NOT r.engine THEN
      bad := bad || format('%s browser=%s engine=%s; ', r.sig, r.browser, r.engine);
    END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'revoke did not take: %', bad; END IF;
END $$;
