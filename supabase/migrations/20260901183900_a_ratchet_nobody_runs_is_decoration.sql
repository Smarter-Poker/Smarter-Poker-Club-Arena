-- Phase 1 audit finding: fn_ca_unledgered_insert_paths() and
-- fn_ca_undeclared_money_paths() were built tonight as ratchets and then
-- scheduled by NOTHING. A detector nobody runs cannot catch a regression;
-- it only makes the repo look defended. This wires both to an hourly
-- watcher that (a) raises an incident when the count grows past its
-- recorded baseline and (b) tightens the baseline when the count shrinks,
-- so ground reclaimed can never be quietly given back.
--
-- It never locks, closes, disables, suspends or freezes anything. It writes
-- one incident row and returns.
--
-- Scheduled as cron job ca-ratchet-watch-hourly ('35 * * * *').

CREATE TABLE IF NOT EXISTS public.ca_ratchet_baselines (
  ratchet      text PRIMARY KEY,
  baseline     integer NOT NULL,
  tightened_at timestamptz NOT NULL DEFAULT now(),
  note         text
);

COMMENT ON TABLE public.ca_ratchet_baselines IS
  'High-water marks for the structural money-path ratchets. baseline only ever moves down (fn_ca_ratchet_watch tightens it); growth past it raises a drift incident.';

INSERT INTO public.ca_ratchet_baselines (ratchet, baseline, note) VALUES
  ('unledgered_insert_paths', (SELECT count(*)::int FROM public.fn_ca_unledgered_insert_paths()),
   'Balance tables whose INSERT path does not reach chip_ledger. Closed to zero 2026-09-01 by chips_cannot_be_born_unledgered.'),
  ('undeclared_money_paths',  (SELECT count(*)::int FROM public.fn_ca_undeclared_money_paths()),
   'Routines writing a balance column without fn_ca_declare_ledger. Drained one path at a time; Phase 5 target is zero.')
ON CONFLICT (ratchet) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_ratchet_watch()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row     record;
  v_current integer;
  v_out     jsonb := '[]'::jsonb;
BEGIN
  FOR v_row IN SELECT * FROM public.ca_ratchet_baselines ORDER BY ratchet LOOP
    IF v_row.ratchet = 'unledgered_insert_paths' THEN
      SELECT count(*)::int INTO v_current FROM public.fn_ca_unledgered_insert_paths();
    ELSIF v_row.ratchet = 'undeclared_money_paths' THEN
      SELECT count(*)::int INTO v_current FROM public.fn_ca_undeclared_money_paths();
    ELSE
      CONTINUE;  -- a baseline with no reader is not an error, it is future work
    END IF;

    IF v_current > v_row.baseline THEN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source          => 'fn_ca_ratchet_watch',
        p_classification  => 'unauthorized_adjustment',
        p_severity        => 'warning',
        p_dedupe_key      => 'ratchet:' || v_row.ratchet || ':above:' || v_row.baseline
                             || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
        p_discrepancy     => (v_current - v_row.baseline)::numeric,
        p_expected        => v_row.baseline::numeric,
        p_actual          => v_current::numeric,
        p_layer           => 'ledger',
        p_suspected_cause => 'A new money path was added that does not declare its ledger counterparty, '
                             || 'or a balance table gained an INSERT path that bypasses chip_ledger. '
                             || 'Read the offending rows with SELECT * FROM ' || v_row.ratchet || '.',
        p_ledger_balanced => true,
        p_metadata        => jsonb_build_object('ratchet', v_row.ratchet,
                                                'baseline', v_row.baseline,
                                                'current',  v_current)
      );

    ELSIF v_current < v_row.baseline THEN
      UPDATE public.ca_ratchet_baselines
         SET baseline = v_current, tightened_at = now()
       WHERE ratchet = v_row.ratchet;
    END IF;

    v_out := v_out || jsonb_build_object('ratchet', v_row.ratchet,
                                         'baseline', v_row.baseline,
                                         'current', v_current);
  END LOOP;

  RETURN jsonb_build_object('checked_at', now(), 'ratchets', v_out);
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_ratchet_watch() IS
  'Hourly. Raises a warning incident when a structural money-path ratchet regresses above its baseline, and tightens the baseline when it improves. Never blocks or disables anything.';

-- Definer authorization, stated explicitly (pre-push gate requires this).
REVOKE ALL ON FUNCTION public.fn_ca_ratchet_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ratchet_watch() TO service_role;

ALTER TABLE public.ca_ratchet_baselines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_ratchet_baselines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ca_ratchet_baselines TO service_role;
