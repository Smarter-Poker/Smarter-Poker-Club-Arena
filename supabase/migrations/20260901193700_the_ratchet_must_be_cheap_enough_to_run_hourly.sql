-- The first live run of ca-ratchet-watch-hourly took 1 minute 29 seconds.
-- fn_rake_law_violations('24 hours') joins a day of hand_history (~250k rows
-- at current volume) to tables, every hour, and that cost grows with the
-- floor. A regression detector that gets more expensive as the platform gets
-- busier is a detector that will one day be switched off.
--
-- The 24-hour depth was never the point. Coverage is layered already:
--   rake-law-adherence-hourly  2h window, hourly   - catches it fast
--   rake-law-wide-daily        26h window, daily   - catches what an outage hid
--   this ratchet                                   - says the floor moved off zero
--
-- So the ratchet reads the same 2-hour window the hourly job does. A
-- violation still raises an incident within the hour, at a twelfth of the
-- scan (measured: 89s -> 12.7s). The baseline stays zero, because zero is
-- zero over any window.
--
-- A statement_timeout is set as well: this function must never be the thing
-- holding a connection open. If the scan cannot finish in 30 seconds, the
-- right outcome is a failed cron run somebody can see, not a wedged job.

CREATE OR REPLACE FUNCTION public.fn_ca_ratchet_watch()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_row record; v_current integer; v_out jsonb := '[]'::jsonb;
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
    ELSE
      CONTINUE;
    END IF;

    IF v_current > v_row.baseline THEN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source          => 'fn_ca_ratchet_watch',
        p_classification  => CASE WHEN v_row.ratchet = 'rake_law_violations_24h'
                                  THEN 'incorrect_rake' ELSE 'unauthorized_adjustment' END,
        p_severity        => CASE WHEN v_row.ratchet = 'rake_law_violations_24h'
                                  THEN 'critical' ELSE 'warning' END,
        p_dedupe_key      => 'ratchet:' || v_row.ratchet || ':above:' || v_row.baseline
                             || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
        p_discrepancy     => (v_current - v_row.baseline)::numeric,
        p_expected        => v_row.baseline::numeric,
        p_actual          => v_current::numeric,
        p_layer           => CASE WHEN v_row.ratchet = 'rake_law_violations_24h'
                                  THEN 'settlement' ELSE 'ledger' END,
        p_suspected_cause => CASE
          WHEN v_row.ratchet = 'rake_law_violations_24h' THEN
            'Chips were raked that the rules did not owe the house, in the last 2 hours. '
            || 'Read the hands with SELECT * FROM fn_rake_law_violations(''2 hours''). '
            || 'rake-law-wide-daily re-reads 26 hours if you need the fuller picture.'
          ELSE
            'A new money path was added that does not declare its ledger counterparty, '
            || 'or a balance table gained an INSERT path that bypasses chip_ledger. '
            || 'Read the offending rows with SELECT * FROM ' || v_row.ratchet || '.' END,
        p_ledger_balanced => true,
        p_metadata        => jsonb_build_object('ratchet', v_row.ratchet,
                                                'baseline', v_row.baseline,
                                                'current',  v_current,
                                                'window', CASE WHEN v_row.ratchet =
                                                  'rake_law_violations_24h' THEN '2 hours' END));
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

UPDATE public.ca_ratchet_baselines
   SET note = 'Illegal rake (no_flop_no_drop, over_cap, over_percent) in the last 2 HOURS - the same window the hourly rake-law job uses, because a 24h scan cost 89 seconds every hour and grows with the floor. Clean since 2026-08-31 16:12. Baseline zero: the next one raises a critical incident by itself.'
 WHERE ratchet = 'rake_law_violations_24h';

REVOKE ALL ON FUNCTION public.fn_ca_ratchet_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ratchet_watch() TO service_role;
