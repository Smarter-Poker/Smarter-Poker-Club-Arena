-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820133751 "union_credit_risk_invariants"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3cb4304754661acc9e7b233f1d2127f5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Credit-risk invariants, folded into the existing governance sweep so the
-- engine sentinel (every 30 min) and the Monday PHASE 8 both pick them up
-- with no code change.
--
-- COST NOTE: the breach check is driven off union_club_terms rows that
-- actually have a stop_loss_limit set. Today none do, so the LATERAL never
-- executes and the check costs nothing. Cost scales only with enforcement
-- adoption, which is the right shape for a check that runs every cycle.
CREATE OR REPLACE FUNCTION public.fn_union_credit_risk_check()
RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  -- No collateral on file. Every real union holds a security deposit per
  -- club; without one the union carries the club's losses unsecured.
  SELECT 'union_club_no_terms', 'warning', count(*),
         'Member clubs with no union_club_terms row: no security deposit and '
         || 'no stop loss on file, so their losses are carried unsecured'
    FROM union_clubs uc
   WHERE NOT EXISTS (SELECT 1 FROM union_club_terms t
                      WHERE t.union_id = uc.union_id AND t.club_id = uc.club_id)
  HAVING count(*) > 0

  UNION ALL
  -- A club past its stop loss that is still active. In a real union this is
  -- the moment play is suspended until the club settles.
  SELECT 'union_club_stop_loss_breached', 'critical', count(*),
         'Clubs past their weekly stop loss and still active: '
         || COALESCE(string_agg(x.club_name || ' (exposure ' || x.exposure || ' vs limit '
                                || x.stop_loss_limit || ')', '; '), '')
    FROM (
      SELECT e.club_name, e.exposure, e.stop_loss_limit
        FROM (SELECT DISTINCT t.union_id
                FROM union_club_terms t
               WHERE t.stop_loss_limit IS NOT NULL
                 AND t.status <> 'suspended') u
        CROSS JOIN LATERAL fn_union_club_exposure(u.union_id) e
       WHERE e.breached AND e.status <> 'suspended'
    ) x
  HAVING count(*) > 0;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_credit_risk_check() FROM PUBLIC, anon, authenticated;

-- Append the credit-risk invariants to the governance sweep by rewriting its
-- body programmatically. Done this way deliberately: the governance function
-- is long and re-typing it by hand risks a transcription error in a check
-- that guards money. This takes the deployed definition verbatim, strips its
-- trailing semicolon, and appends one UNION ALL.
DO $$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_governance_check';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_union_governance_check not found';
  END IF;

  IF position('fn_union_credit_risk_check' in v_src) > 0 THEN
    RETURN;  -- already appended; idempotent
  END IF;

  v_new := regexp_replace(v_src, ';\s*$', '');
  v_new := v_new || E'\n\n  UNION ALL\n  SELECT * FROM fn_union_credit_risk_check()\n';

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.fn_union_governance_check() '
    'RETURNS TABLE(invariant text, severity text, offenders bigint, detail text) '
    'LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''public'' AS %L',
    v_new);
END $$;
