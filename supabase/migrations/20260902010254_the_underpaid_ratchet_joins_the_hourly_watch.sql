-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902010254; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Eighth ratchet. Underpayment is a CRITICAL: a player who was promised a
-- guaranteed prize pool and paid less than it is the one failure on this
-- platform that a player can see and the operator cannot argue with.

CREATE OR REPLACE FUNCTION public.fn_ca_ratchet_watch()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_row record; v_current integer; v_out jsonb := '[]'::jsonb; v_crit boolean;
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
    ELSIF v_row.ratchet = 'completed_without_a_champion' THEN
      SELECT public.fn_ca_completed_without_a_champion() INTO v_current;
    ELSIF v_row.ratchet = 'prize_overpay_unexplained_10d' THEN
      SELECT public.fn_ca_prize_overpay_count() INTO v_current;
    ELSIF v_row.ratchet = 'rake_distributed_exceeds_collected_1h' THEN
      SELECT public.fn_ca_rake_distribution_mismatch_count() INTO v_current;
    ELSIF v_row.ratchet = 'tournament_underpaid_48h' THEN
      SELECT public.fn_ca_tournament_underpaid_count() INTO v_current;
    ELSE
      CONTINUE;
    END IF;

    v_crit := v_row.ratchet IN ('rake_law_violations_24h','reconciler_delete_unscoped',
                                'completed_without_a_champion','prize_overpay_unexplained_10d',
                                'rake_distributed_exceeds_collected_1h','tournament_underpaid_48h');

    IF v_current > v_row.baseline THEN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source          => 'fn_ca_ratchet_watch',
        p_classification  => CASE v_row.ratchet
                               WHEN 'rake_law_violations_24h' THEN 'incorrect_rake'
                               WHEN 'rake_distributed_exceeds_collected_1h' THEN 'incorrect_rake'
                               WHEN 'reconciler_delete_unscoped' THEN 'reporting_mismatch'
                               WHEN 'tournament_underpaid_48h' THEN 'missing_payment'
                               WHEN 'completed_without_a_champion' THEN 'settlement_error'
                               WHEN 'prize_overpay_unexplained_10d' THEN 'settlement_error'
                               ELSE 'unauthorized_adjustment' END,
        p_severity        => CASE WHEN v_crit THEN 'critical' ELSE 'warning' END,
        p_dedupe_key      => 'ratchet:' || v_row.ratchet || ':above:' || v_row.baseline
                             || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
        p_discrepancy     => (v_current - v_row.baseline)::numeric,
        p_expected        => v_row.baseline::numeric,
        p_actual          => v_current::numeric,
        p_layer           => CASE v_row.ratchet
                               WHEN 'reconciler_delete_unscoped' THEN 'reporting'
                               WHEN 'undeclared_money_paths' THEN 'ledger'
                               WHEN 'unledgered_insert_paths' THEN 'ledger'
                               ELSE 'settlement' END,
        p_suspected_cause => CASE v_row.ratchet
          WHEN 'rake_law_violations_24h' THEN
            'Chips were raked that the rules did not owe the house, in the last 2 hours.'
          WHEN 'rake_distributed_exceeds_collected_1h' THEN
            'A larger share of raked hands is banking more rake than was taken from the pot.'
          WHEN 'reconciler_delete_unscoped' THEN
            'reconcile_ledger_nightly has lost its scoped DELETE and is again clearing '
            || 'ledger_reconcile_log rows it never wrote.'
          WHEN 'tournament_underpaid_48h' THEN
            'A tournament paid players LESS than it owed - GREATEST(prize_pool, '
            || 'guaranteed_prize). Every case found so far was a guarantee that was never '
            || 'topped up, so the advertised prize pool and the paid one differ. Read them '
            || 'with SELECT * FROM fn_ca_tournament_settlement_mismatch() WHERE kind=''underpaid''.'
          WHEN 'completed_without_a_champion' THEN
            'A tournament finished without anybody marked winner, so every settlement '
            || 'that reads status=winner is stuck.'
          WHEN 'prize_overpay_unexplained_10d' THEN
            'A tournament paid out more than its prize pool AND more than its guarantee, '
            || 'and it is neither a satellite nor a Spin.'
          ELSE
            'A new money path was added that does not declare its ledger counterparty.' END,
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

