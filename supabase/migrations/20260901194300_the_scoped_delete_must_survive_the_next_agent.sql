-- the_reconciler_stops_eating_the_rake_evidence patched
-- reconcile_ledger_nightly IN PLACE: it read the live definition, replaced the
-- unscoped DELETE, and re-executed it. That was the right call at the time --
-- the function is ~600 lines owned by another workstream, and re-pasting a
-- copy here would silently revert whatever had landed in it since.
--
-- But it leaves the fix undefended. reconcile_ledger_nightly lives in the
-- repository too, and the next agent to run CREATE OR REPLACE on it from
-- their copy restores the unscoped DELETE, the rake evidence starts being
-- destroyed every six hours again, and NOTHING says so: there is no test that
-- can see a live function body, and the incident that would have been raised
-- is the very thing being deleted.
--
-- That is the same shape as every bug this sweep has been about: a fix with
-- nothing holding it in place. So the ratchet holds it. baseline 0, and the
-- hourly watcher raises a critical incident the moment the scoping is gone --
-- whoever removed it, however they removed it.

CREATE OR REPLACE FUNCTION public.fn_ca_reconciler_delete_unscoped()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $fn$
  SELECT CASE
           WHEN NOT EXISTS (
             SELECT 1 FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'reconcile_ledger_nightly'
           ) THEN 1                      -- missing entirely is also not healthy
           WHEN (SELECT pg_get_functiondef(p.oid)
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'reconcile_ledger_nightly'
                  LIMIT 1)
                ILIKE '%fn_ca_reconcile_owned_entity_types()%' THEN 0
           ELSE 1
         END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_reconciler_delete_unscoped() IS
  'Returns 1 if reconcile_ledger_nightly has lost its scoped DELETE and is again clearing ledger_reconcile_log rows written by other jobs (rake_law). Watched hourly by fn_ca_ratchet_watch at baseline 0.';

REVOKE ALL ON FUNCTION public.fn_ca_reconciler_delete_unscoped() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_reconciler_delete_unscoped() TO service_role;

INSERT INTO public.ca_ratchet_baselines (ratchet, baseline, note) VALUES
  ('reconciler_delete_unscoped', 0,
   'reconcile_ledger_nightly must delete only the entity types it writes. It was patched in place on 2026-09-01, so a CREATE OR REPLACE from any repository copy silently restores the unscoped DELETE and the rake-law evidence starts being destroyed again. Baseline 0 with nothing else watching it.')
ON CONFLICT (ratchet) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_ratchet_watch()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_row record; v_current integer; v_out jsonb := '[]'::jsonb; v_rake boolean;
BEGIN
  FOR v_row IN SELECT * FROM public.ca_ratchet_baselines ORDER BY ratchet LOOP
    IF v_row.ratchet = 'unledgered_insert_paths' THEN
      SELECT count(*)::int INTO v_current FROM public.fn_ca_unledgered_insert_paths();
    ELSIF v_row.ratchet = 'undeclared_money_paths' THEN
      SELECT count(*)::int INTO v_current FROM public.fn_ca_undeclared_money_paths();
    ELSIF v_row.ratchet = 'rake_law_violations_24h' THEN
      SELECT count(*)::int INTO v_current
        FROM public.fn_rake_law_violations('2 hours'::interval)
       WHERE kind IN ('no_flop_no_drop','over_cap','over_percent');
    ELSIF v_row.ratchet = 'reconciler_delete_unscoped' THEN
      SELECT public.fn_ca_reconciler_delete_unscoped() INTO v_current;
    ELSE
      CONTINUE;
    END IF;

    v_rake := v_row.ratchet IN ('rake_law_violations_24h','reconciler_delete_unscoped');

    IF v_current > v_row.baseline THEN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source          => 'fn_ca_ratchet_watch',
        p_classification  => CASE WHEN v_row.ratchet = 'rake_law_violations_24h'
                                  THEN 'incorrect_rake'
                                  WHEN v_row.ratchet = 'reconciler_delete_unscoped'
                                  THEN 'reporting_mismatch'
                                  ELSE 'unauthorized_adjustment' END,
        p_severity        => CASE WHEN v_rake THEN 'critical' ELSE 'warning' END,
        p_dedupe_key      => 'ratchet:' || v_row.ratchet || ':above:' || v_row.baseline
                             || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
        p_discrepancy     => (v_current - v_row.baseline)::numeric,
        p_expected        => v_row.baseline::numeric,
        p_actual          => v_current::numeric,
        p_layer           => CASE WHEN v_row.ratchet = 'rake_law_violations_24h'
                                  THEN 'settlement'
                                  WHEN v_row.ratchet = 'reconciler_delete_unscoped'
                                  THEN 'reporting' ELSE 'ledger' END,
        p_suspected_cause => CASE
          WHEN v_row.ratchet = 'rake_law_violations_24h' THEN
            'Chips were raked that the rules did not owe the house, in the last 2 hours. '
            || 'Read the hands with SELECT * FROM fn_rake_law_violations(''2 hours''). '
            || 'rake-law-wide-daily re-reads 26 hours if you need the fuller picture.'
          WHEN v_row.ratchet = 'reconciler_delete_unscoped' THEN
            'reconcile_ledger_nightly has lost its scoped DELETE and is again clearing '
            || 'ledger_reconcile_log rows it never wrote. Rake-law evidence is being '
            || 'destroyed every six hours. Re-apply the scoping from migration '
            || 'the_reconciler_stops_eating_the_rake_evidence.'
          ELSE
            'A new money path was added that does not declare its ledger counterparty, '
            || 'or a balance table gained an INSERT path that bypasses chip_ledger. '
            || 'Read the offending rows with SELECT * FROM ' || v_row.ratchet || '.' END,
        p_ledger_balanced => true,
        p_metadata        => jsonb_build_object('ratchet', v_row.ratchet,
                                                'baseline', v_row.baseline,
                                                'current',  v_current));
    ELSIF v_current < v_row.baseline THEN
      UPDATE public.ca_ratchet_baselines
         SET baseline = v_current, tightened_at = now()
       WHERE ratchet = v_row.ratchet;
    END IF;

    v_out := v_out || jsonb_build_object('ratchet', v_row.ratchet,
                                         'baseline', v_row.baseline, 'current', v_current);
  END LOOP;

  RETURN jsonb_build_object('checked_at', now(), 'ratchets', v_out);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_ratchet_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ratchet_watch() TO service_role;
