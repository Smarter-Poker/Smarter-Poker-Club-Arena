-- Repo copy of production migration
-- `final_alert_sweep_after_phase3_verification` (applied 2026-08-31 via
-- Supabase MCP). See
-- docs/changelog/2026-08-31-phase3-the-settler-was-asked-an-o-week-question.md
--
-- CLOSING OUT THE PHASE 1-3 VERIFICATION PASS.
--
-- Two alert families were left, and both are explained by this session's own
-- work rather than by anything wrong with the platform.
--
-- 1. FeeReconciler.queue_failed — "Could not query the database for the schema
--    cache". PostgREST reloads its schema cache on every migration, and this
--    session applied many; a fee write landing inside a reload window gets
--    this error. Recurring at ~20-minute spacing, matching the apply cadence,
--    and it stops when the DDL stops. The chips are not lost: the hand keeps
--    its rake_records row and fn_bbj_repair_unbanked heals the BBJ side from
--    it on the hourly pass.
--
-- 2. fn_rake_bbj_audit — thirteen alerts accumulated through the pass, none a
--    live money problem. The I4 entries were an artifact of the backfill in
--    this same session: that check scopes on rake_records.created_at (BANKING
--    time, not hand time), so re-queuing 2026-08-29 hands today dragged
--    genuinely old "no BBJ drop taken" facts into a 2-hour window and reported
--    them as fresh. They age out. The I5 entries were real unbanked BBJ
--    contributions and are healed here from rake_records by the canonical
--    repair function rather than by hand.
--
-- Everything is gated on a live re-read: if the audit is not actually clean
-- when this runs, nothing is resolved. Verified after: violations 0, and the
-- only criticals left open are the two that belong to Dan
-- (lapsed_week_unclosed behind his settlement freeze, and the open
-- bbj_pool_conservation_drift investigation that freeze exists for).

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.fn_bbj_repair_unbanked(24, 200);
  RAISE NOTICE 'healed % unbanked BBJ contribution(s)', n;
END $$;

UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(),
       context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
         'resolution',
         'Resolved 2026-08-31 during the phase 1-3 verification pass, gated on a live re-read of fn_rake_bbj_audit returning zero violations. The I4 entries were an artifact of this session backfilling orphaned fees: that check scopes on rake_records.created_at, so re-banking old hands reported their historical "no BBJ drop" as fresh. The I5 entries were healed from rake_records by fn_bbj_repair_unbanked.')
 WHERE source = 'fn_rake_bbj_audit'
   AND resolved IS NOT TRUE
   AND (SELECT (fn_rake_bbj_audit()->>'violations')::int) = 0;

UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now(),
       context = COALESCE(fa.context, '{}'::jsonb) || jsonb_build_object(
         'resolution',
         'Resolved 2026-08-31: PostgREST schema-cache reload window caused by this session applying migrations, not a lost fee. Gated on the hand carrying its rake_records row and its BBJ contribution now being banked.')
 WHERE fa.source = 'FeeReconciler.queue_failed'
   AND fa.resolved IS NOT TRUE
   AND EXISTS (
     SELECT 1 FROM public.hand_history hh
      WHERE hh.id::text = (regexp_match(fa.message, 'hand ([0-9a-f]{8}-[0-9a-f-]{27,})'))[1]
        AND EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = hh.id)
        AND EXISTS (SELECT 1 FROM public.bbj_contributions b WHERE b.hand_id = hh.id));

DO $$
DECLARE v_viol int; v_open int;
BEGIN
  v_viol := (fn_rake_bbj_audit()->>'violations')::int;
  SELECT count(*) INTO v_open FROM public.financial_alerts
   WHERE resolved IS NOT TRUE AND severity = 'critical'
     AND source NOT IN ('fn_union_treasury_selftest');
  RAISE NOTICE 'live rake/bbj violations: %, non-selftest criticals open: %', v_viol, v_open;
END $$;
