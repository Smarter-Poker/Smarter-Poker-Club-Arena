-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901230638; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3: THE CHAMPION WHO WAS NEVER MARKED THE CHAMPION
--
-- The 24 unpaid bounty chips were not a bounty bug. The tournament finished
-- with eleven players eliminated at positions 2..12 and the twelfth still
-- carrying tournament_players.status = 'playing' at position 1. The engine
-- marked the EVENT completed and never transitioned the last player to
-- 'winner', so every downstream reader that asks "who won?" finds nobody:
-- bounty finalisation has no recipient, and the pool sits.
--
-- MEASURED across 50,572 completed events: 52 have no winner recorded, and in
-- ALL 52 the champion is sitting in 'playing'. Not one has a different shape,
-- and there are no events with two winners. Every one falls between
-- 2026-08-21 05:57 and 2026-08-27 01:17; 15,163 events have completed since
-- without a single recurrence, so the engine defect itself is already closed.
--
-- What was NOT closed is that nothing would have told us. There is no guard
-- that says a finished tournament must have a champion, so the 52 sat for
-- eleven days and surfaced only because one of them happened to hold a bounty
-- pool that a different check noticed.
--
-- Two additions, no money moved:
--
--   1. fn_ca_completed_without_a_champion() counts them, and joins the hourly
--      ratchet at the current 52. The count can only fall; a 53rd raises a
--      critical incident naming the event.
--   2. ca-bounty-backpay-hourly runs the (now reachable) settlement, so a
--      pool with a recorded champion is paid without waiting for a human to
--      notice. It settles only to a champion the record already names, and
--      alerts rather than guessing when there is none.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_completed_without_a_champion()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT count(*)::int
    FROM public.tournaments t
   WHERE t.status = 'COMPLETED'
     AND EXISTS (SELECT 1 FROM public.tournament_players tp
                  WHERE tp.tournament_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                      WHERE tp.tournament_id = t.id AND tp.status = 'winner');
$fn$;

COMMENT ON FUNCTION public.fn_ca_completed_without_a_champion() IS
  'Completed tournaments that have players but nobody marked winner. Every one is a settlement that cannot complete: bounty pools, prizes and stats all read status=winner. 52 on 2026-09-01, all from the 2026-08-21..27 window, all with the champion still in status=playing.';

REVOKE ALL ON FUNCTION public.fn_ca_completed_without_a_champion() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_completed_without_a_champion() TO service_role;

INSERT INTO public.ca_ratchet_baselines (ratchet, baseline, note)
SELECT 'completed_without_a_champion',
       public.fn_ca_completed_without_a_champion(),
       'Completed tournaments with players but no winner recorded. All 52 are the 2026-08-21..27 cohort where the engine left the champion in status=playing; 15,163 events have completed since with no recurrence. The count can only fall. A rise means the engine has stopped naming champions again, and every settlement downstream of that is stuck.'
ON CONFLICT (ratchet) DO NOTHING;

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
    ELSE
      CONTINUE;
    END IF;

    v_crit := v_row.ratchet IN ('rake_law_violations_24h','reconciler_delete_unscoped',
                                'completed_without_a_champion');

    IF v_current > v_row.baseline THEN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source          => 'fn_ca_ratchet_watch',
        p_classification  => CASE v_row.ratchet
                               WHEN 'rake_law_violations_24h' THEN 'incorrect_rake'
                               WHEN 'reconciler_delete_unscoped' THEN 'reporting_mismatch'
                               WHEN 'completed_without_a_champion' THEN 'settlement_error'
                               ELSE 'unauthorized_adjustment' END,
        p_severity        => CASE WHEN v_crit THEN 'critical' ELSE 'warning' END,
        p_dedupe_key      => 'ratchet:' || v_row.ratchet || ':above:' || v_row.baseline
                             || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
        p_discrepancy     => (v_current - v_row.baseline)::numeric,
        p_expected        => v_row.baseline::numeric,
        p_actual          => v_current::numeric,
        p_layer           => CASE v_row.ratchet
                               WHEN 'rake_law_violations_24h' THEN 'settlement'
                               WHEN 'reconciler_delete_unscoped' THEN 'reporting'
                               WHEN 'completed_without_a_champion' THEN 'settlement'
                               ELSE 'ledger' END,
        p_suspected_cause => CASE v_row.ratchet
          WHEN 'rake_law_violations_24h' THEN
            'Chips were raked that the rules did not owe the house, in the last 2 hours. '
            || 'Read the hands with SELECT * FROM fn_rake_law_violations(''2 hours'').'
          WHEN 'reconciler_delete_unscoped' THEN
            'reconcile_ledger_nightly has lost its scoped DELETE and is again clearing '
            || 'ledger_reconcile_log rows it never wrote. Rake-law evidence is being '
            || 'destroyed every six hours.'
          WHEN 'completed_without_a_champion' THEN
            'A tournament finished without anybody marked winner, so every settlement '
            || 'that reads status=winner is stuck: bounty pools have no recipient and '
            || 'prizes have no claimant. Check whether the last player is still sitting '
            || 'in status=playing, which is how all 52 of the known cohort look.'
          ELSE
            'A new money path was added that does not declare its ledger counterparty, '
            || 'or a balance table gained an INSERT path that bypasses chip_ledger.' END,
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

