-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830053409; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

SET statement_timeout = '300s';

-- ═══════════════════════════════════════════════════════════════════════════
-- POLISH 3: the attribution-drift watchdog gets a second seat, DB-side
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_rake_attribution_drift is read by FeeReconciler.auditRakeAttributionDrift
-- inside the ENGINE's reconcile cycle. That is one seat, and it shares a
-- failure domain with the thing it watches: an engine that is down, wedged,
-- or crash-looping is exactly when attribution breaks AND exactly when the
-- only watcher is not running. The same reasoning already put
-- fn_rake_repair_unbanked and fn_rake_bbj_audit in pg_cron ("recovery that
-- lives in the engine cannot survive the engine dying").
--
-- This is the DB-side seat: same query, same threshold, running on the
-- database's own clock. Both seats file into financial_alerts and both are
-- idempotent to run, so the overlap costs nothing and the coverage survives
-- any engine outage.
CREATE OR REPLACE FUNCTION public.fn_rake_attribution_drift_audit(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n bigint := 0;
  v_chips numeric := 0;
  v_sample jsonb := '[]'::jsonb;
BEGIN
  SELECT count(*), COALESCE(SUM(difference), 0),
         COALESCE(jsonb_agg(jsonb_build_object('hand', hand_id, 'rake', rake_amount,
                                               'allocated', allocated, 'diff', difference)), '[]'::jsonb)
    INTO v_n, v_chips, v_sample
    FROM (SELECT * FROM public.fn_rake_attribution_drift(p_hours) LIMIT 25) d;

  IF v_n > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_rake_attribution_drift_audit',
            'RAKE_ALLOCATION_MISMATCH (db-side watchdog): ' || v_n ||
              ' weighted hand(s) in the last ' || p_hours || 'h whose per-player ledger does not ' ||
              'sum to the rake collected (net ' || round(v_chips, 2) || ' chips). The allocator ' ||
              'guarantees this by construction, so a hit means a lost ledger write or disagreeing code.',
            jsonb_build_object('hours', p_hours, 'hands', v_n,
                               'net_chips', round(v_chips, 2), 'sample', v_sample));
  END IF;

  RETURN jsonb_build_object('hours', p_hours, 'drift_hands', v_n, 'net_chips', round(v_chips, 2));
END $function$;

REVOKE ALL ON FUNCTION public.fn_rake_attribution_drift_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_attribution_drift_audit(integer) TO service_role;

-- :47 — deliberately offset from the :38 invariant audit and the :52 rake
-- repair so the three guards never contend for the same locks.
SELECT cron.schedule('rake-attribution-drift-audit-hourly', '47 * * * *', $cron$
  select case
           when pg_try_advisory_lock(hashtext('rake-attribution-drift-audit'))
             then (select (public.fn_rake_attribution_drift_audit(24))::text)
           else 'skipped: previous run still in progress'
         end;
$cron$);

-- ═══════════════════════════════════════════════════════════════════════════
-- POLISH 5: the dead bbj_contributions.player_id column
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NULL on every row ever written (550,782+ at last count) and never populated
-- by any code path: bbj_record_contribution has no player parameter, and
-- logBBJCollection never passes one. It is a trap — BadBeatJackpotPage once
-- read it and got nothing, and any future reader would do the same.
--
-- Per-player BBJ attribution is REAL now and lives in
-- rake_attributions.bbj_attributed_contribution (weighted by eligible
-- contribution, reconciled hand-by-hand), rolled up daily into
-- bbj_daily_user. The column is dropped so nothing can mistake it for data
-- again. Verified NULL-only immediately before the drop; the DO block below
-- refuses to drop it if a single row ever held a value.
DO $$
DECLARE v_populated bigint;
BEGIN
  SELECT count(*) INTO v_populated FROM public.bbj_contributions WHERE player_id IS NOT NULL;
  IF v_populated > 0 THEN
    RAISE EXCEPTION 'bbj_contributions.player_id has % populated row(s) — it is NOT dead, do not drop it', v_populated;
  END IF;
  EXECUTE 'ALTER TABLE public.bbj_contributions DROP COLUMN player_id';
  RAISE NOTICE 'dropped bbj_contributions.player_id (0 populated rows, ever)';
END $$;

COMMENT ON TABLE public.bbj_contributions IS
  'Per-HAND jackpot funding ledger (one row per hand, three bank portions). '
  'Per-PLAYER BBJ attribution lives in rake_attributions.bbj_attributed_contribution '
  '(weighted by eligible contribution, Dan 2026-08-29) and rolls up into bbj_daily_user. '
  'The never-written player_id column was dropped 2026-08-30.';
