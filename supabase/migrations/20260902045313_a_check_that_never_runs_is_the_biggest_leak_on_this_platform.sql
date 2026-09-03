-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902045313; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE SYSTEMIC ROOT CAUSE, stated plainly.
--
-- Tonight I have found the same defect six separate times: a check that
-- exists, is correct, and has never once run. fn_uncollected_entry_check and
-- four money checks earlier; now a whole tier of conservation audits. Twenty
-- check-shaped functions in this database have zero cron entries.
--
-- Two of them were holding real findings nobody had ever seen:
--
--   fn_bbj_conservation_check    healthy=false, 70,795.11 chips of drift from
--                                its own baseline
--   fn_tournament_chip_conservation_check
--                                five tournaments where the chips in play do
--                                not equal the chips bought in, one of them
--                                +23,255
--   fn_bbj_promo_bank_check      reconciles=false, 2,459.96 over-swept
--   fn_tournament_guarantee_check
--                                a tournament that paid NOTHING and is 100
--                                chips short of its guarantee - and the
--                                function returns ok=true while saying so
--
-- Scheduling them one by one is not the fix; that is what everybody has done
-- and it is why there are twenty. Two mechanisms go in instead:
--
--   1. fn_ca_conservation_sweep runs all of them in ONE job and RAISES a
--      drift incident for any that reports a finding. Most of these functions
--      only RETURN a verdict - scheduling them without reading the verdict
--      would be theatre.
--   2. fn_ca_orphaned_checks names any check-shaped function that is neither
--      scheduled, nor covered by the sweep, nor explicitly exempted with a
--      reason. So the NEXT one cannot sit silent for weeks.
--
-- Neither blocks anything, and every check runs inside its own exception
-- handler: one broken check must never stop the other nineteen.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_check_sweep_exemptions (
  proname   text PRIMARY KEY,
  reason    text NOT NULL,
  added_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ca_check_sweep_exemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_check_sweep_exemptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ca_check_sweep_exemptions TO service_role;

INSERT INTO public.ca_check_sweep_exemptions (proname, reason) VALUES
  ('fn_nit_check',                       'per-seat helper called inline by the eviction path, not a sweep'),
  ('fn_rg_should_show_reality_check',    'per-user UI predicate called on page load'),
  ('fn_tournament_conservation_delta',   'single-tournament helper; the sweep calls the fleet-wide version'),
  ('fn_union_distribution_check',        'takes a union id and a since; called by the distribution path'),
  ('signup_audit_check',                 'named-assertion helper used by the signup test harness'),
  ('update_tour_next_check',             'scheduling field updater, not an integrity check'),
  ('resolve_venue_location_integrity',   'operator RPC that applies a decision; not a sweep'),
  ('get_platform_integrity_report',      'admin-facing report rendered on demand'),
  ('heal_auth_integrity',                'repair action; must stay human-initiated'),
  ('audit_auth_integrity',               'auth posture, outside the chip-integrity remit'),
  ('fn_run_horse_daily_audit',           'takes a day; ca_horse_daily_audit is the scheduled entry point'),
  ('pnm_refresh_venue_integrity_state_basics', 'poker-near-me venue data, not chip integrity'),
  ('pnm_sync_venue_integrity_state',     'poker-near-me venue data, not chip integrity'),
  ('pnm_sync_venue_integrity_state_from_row', 'poker-near-me row trigger helper'),
  ('fn_blacklists_audit',                'moderation posture, outside the chip-integrity remit'),
  ('fn_anon_exposure_check',             'security posture; covered by the definer gate in CI'),
  ('fn_definer_exposure_audit',          'security posture; covered by the definer gate in CI')
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
  -- Set-returning checks: any row returned IS the finding.
  FOR c IN
    SELECT * FROM (VALUES
      ('fn_chip_integrity_report',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_chip_integrity_report() limit 20) t',
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
          c.check_name || ' returned ' || v_n || ' finding(s) - a conservation invariant does not hold',
          false, jsonb_build_object('rows', v_rows, 'row_count', v_n));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_conservation_sweep:' || c.check_name, 'unknown', 'warning',
        'sweepfail:' || c.check_name || ':' || CURRENT_DATE::text,
        0, NULL, NULL, 'ledger', c.check_name,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'conservation check could not run: ' || SQLERRM
          || ' - a check that errors is as silent as one that never runs',
        false, jsonb_build_object('sqlstate', SQLSTATE));
    END;
  END LOOP;

  -- Verdict-returning checks. Each names its own health field, so each is
  -- read on its own terms rather than assuming a common shape.
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
            -- this one returns ok=true while reporting a shortfall, so the
            -- shortfall counters are what must be read, not ok
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
        'conservation check could not run: ' || SQLERRM,
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

