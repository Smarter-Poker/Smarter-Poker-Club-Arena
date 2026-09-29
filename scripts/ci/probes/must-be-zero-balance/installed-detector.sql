-- THE RED HALF: public.fn_ca_suspense_regression_check exactly as installed in
-- production before migration 20260925131500, read from pg_get_functiondef on
-- project kuklfnapbkmacvwxktbh, 2026-09-25 (md5 0d5579e36566f6f0c4ec1285549e11e6).
--
-- It sums SIXTY MINUTES OF FLOW. A must_be_zero account that stands at four
-- million with nothing moving through it is, to this function, a quiet hour.
-- The probe installs it, seeds exactly that state, and proves it reports
-- nothing - before installing the candidate and proving the same state is
-- reported. Never edited to make a point: this file is the preimage.
CREATE OR REPLACE FUNCTION public.fn_ca_suspense_regression_check()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  DECLARE
    v_in numeric; v_out numeric; v_net numeric;
    v_rows_in int; v_rows_out int;
    v_since constant timestamptz := '2026-09-01 00:17:00+00';
  BEGIN
    SELECT count(*) FILTER (WHERE to_type = 'settlement_suspense'),
           COALESCE(sum(amount) FILTER (WHERE to_type = 'settlement_suspense'), 0),
           count(*) FILTER (WHERE from_type = 'settlement_suspense'),
           COALESCE(sum(amount) FILTER (WHERE from_type = 'settlement_suspense'), 0)
      INTO v_rows_in, v_in, v_rows_out, v_out
      FROM public.chip_ledger
     WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
       AND created_at > now() - interval '60 minutes'
       AND created_at > v_since;

    v_net := round(COALESCE(v_in, 0) - COALESCE(v_out, 0), 2);

    IF abs(v_net) > 1.00 THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_suspense_regression_check', 'unauthorized_adjustment', 'warning',
        'suspense-regression',
        v_net, NULL, NULL, 'ledger', 'settlement_suspense',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        format('suspense kept %s chips in the last hour: %s leg(s) in for %s, %s leg(s) out for %s. A money path lost, or never had, its category declaration and nothing came back for it. Gross flow through suspense is not a finding - what it keeps is.',
               v_net, v_rows_in, round(COALESCE(v_in,0), 2), v_rows_out, round(COALESCE(v_out,0), 2)),
        false,
        jsonb_build_object('net_last_hour', v_net,
                           'legs_in', v_rows_in, 'chips_in', round(COALESCE(v_in,0), 2),
                           'legs_out', v_rows_out, 'chips_out', round(COALESCE(v_out,0), 2)));
      RETURN 1;
    END IF;
    RETURN 0;
  END $function$;
