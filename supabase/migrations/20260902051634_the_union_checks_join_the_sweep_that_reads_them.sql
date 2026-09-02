-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902051634; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- The last seven orphans. Five are union integrity checks that already hold
-- findings nobody has ever seen: credit_risk 2, governance 4,
-- house_club_stamp 1, law_integrity 1, overload 0.
--
-- They are added to the SWEEP rather than given their own cron entries,
-- because scheduling a function that only RETURNS rows and raises nothing is
-- the exact theatre this whole exercise exists to end. Inside the sweep, any
-- row returned becomes an incident.
--
-- The two parameterised ones are exempted with reasons: they take an id or a
-- date and answer a question about one subject, which is not a sweep.

BEGIN;

INSERT INTO public.ca_check_sweep_exemptions (proname, reason) VALUES
  ('fn_club_profit_conservation', 'takes a club id and a date; answers a question about one club-day, not a fleet-wide invariant'),
  ('ca_horse_daily_audit',        'takes a day window and reports horse activity; operations reporting, not a chip-integrity invariant')
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_conservation_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c record; v_n bigint; v_rows jsonb; v_verdict jsonb;
  v_found int := 0; v_failed int := 0; v_ran int := 0;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('fn_chip_integrity_report',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_chip_integrity_report() where severity <> ''ok'' limit 20) t',
       'warning'),
      ('fn_settlement_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_settlement_conservation_check() limit 20) t',
       'critical'),
      ('fn_union_chip_integrity_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_chip_integrity_check() limit 20) t',
       'critical'),
      ('fn_union_money_path_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_money_path_check() limit 20) t',
       'warning'),
      ('fn_club_arena_global_wallet_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_club_arena_global_wallet_check() limit 20) t',
       'warning'),
      ('fn_tournament_chip_conservation_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_chip_conservation_check(0.01) limit 20) t',
       'warning'),
      ('fn_satellite_conservation_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_satellite_conservation_audit(24) limit 20) t',
       'warning'),
      ('fn_tournament_prize_disbursement_audit',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_tournament_prize_disbursement_audit(24) limit 20) t',
       'warning'),
      ('fn_union_credit_risk_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_credit_risk_check() limit 20) t',
       'warning'),
      ('fn_union_governance_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_governance_check() limit 20) t',
       'warning'),
      ('fn_union_house_club_stamp_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_house_club_stamp_check() limit 20) t',
       'warning'),
      ('fn_union_law_integrity_breaches',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_law_integrity_breaches() limit 20) t',
       'critical'),
      ('fn_union_overload_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_overload_check() limit 20) t',
       'warning')
    ) v(check_name, q, sev)
  LOOP
    BEGIN
      v_ran := v_ran + 1;
      EXECUTE c.q INTO v_n, v_rows;
      IF COALESCE(v_n,0) > 0 THEN
        v_found := v_found + 1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:' || c.check_name, 'ledger_imbalance', c.sev,
          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          0, NULL, NULL, 'ledger', c.check_name,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          c.check_name || ' returned ' || v_n || ' finding(s) - an invariant does not hold',
          false, jsonb_build_object('rows', v_rows, 'row_count', v_n));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:' || c.check_name, 'unknown', 'warning',
        'sweepfail:' || c.check_name || ':' || CURRENT_DATE::text,
        0, NULL, NULL, 'ledger', c.check_name,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'check could not run: ' || SQLERRM
          || ' - a check that errors is as silent as one that never runs',
        false, jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END LOOP;

  FOR c IN
    SELECT * FROM (VALUES
      ('fn_bbj_conservation_check',   'select public.fn_bbj_conservation_check()',   'healthy'),
      ('fn_bbj_promo_bank_check',     'select public.fn_bbj_promo_bank_check()',     'reconciles'),
      ('fn_settler_lag_check',        'select public.fn_settler_lag_check()',        'healthy'),
      ('fn_tournament_guarantee_check','select public.fn_tournament_guarantee_check(24)','__guarantee')
    ) v(check_name, q, health_key)
  LOOP
    BEGIN
      v_ran := v_ran + 1;
      EXECUTE c.q INTO v_verdict;

      IF (c.health_key = '__guarantee'
            AND (COALESCE((v_verdict->>'short_of_guarantee')::numeric,0) > 0
              OR COALESCE((v_verdict->>'paid_nothing')::numeric,0) > 0))
         OR (c.health_key <> '__guarantee'
            AND COALESCE((v_verdict->>c.health_key)::boolean, true) IS NOT TRUE)
      THEN
        v_found := v_found + 1;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_conservation_sweep:' || c.check_name, 'ledger_imbalance', 'warning',
          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          COALESCE((v_verdict->>'drift_from_baseline')::numeric,
                   (v_verdict->>'over_swept')::numeric,
                   (v_verdict->>'chips_short')::numeric, 0),
          NULL, NULL, 'ledger', c.check_name,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          c.check_name || ' reports a conservation failure',
          false, v_verdict);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:' || c.check_name, 'unknown', 'warning',
        'sweepfail:' || c.check_name || ':' || CURRENT_DATE::text,
        0, NULL, NULL, 'ledger', c.check_name,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'check could not run: ' || SQLERRM,
        false, jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'checks_run', v_ran,
                            'with_findings', v_found, 'errored', v_failed);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_conservation_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_conservation_sweep() TO service_role;

COMMIT;

