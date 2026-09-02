-- Repo copy of production migration
-- `two_sweeps_that_never_finished_get_a_timeout` (applied 2026-08-31 via
-- Supabase MCP). See
-- docs/changelog/2026-08-31-phase3-the-settler-was-asked-an-o-week-question.md
--
-- TWO SWEEPS THAT COULD NEVER FINISH, AND ONE OF THEM WAS MINE.
--
-- PostgREST cancels at ~8s unless a function raises its own ceiling. Neither
-- of these did, so both died mid-scan on every call while reporting a tidy
-- error nobody was reading.
--
-- 1. fn_requeue_unbanked_cash_rake — SHIPPED BROKEN BY ME EARLIER TODAY.
--    Wired into the reconciler in phase 2; the first production run logged
--    "[FeeReconciler.requeue_unbanked_query_failed] 57014 canceling statement
--    due to statement timeout". Measured: the 48h scan takes 12.9s — the index
--    returns 380,864 rows for the window, 325,039 are discarded as tournament
--    or zero-rake hands, and 55,825 anti-join probes remain to find a handful.
--    The self-healing sweep had never once healed anything. Fixed with a real
--    ceiling AND a default window that matches the cadence (6h, 3.3s measured;
--    at a 5-minute cycle that is ~72 chances to catch an orphaned hand).
--
-- 2. fn_tournament_payout_sweep — PRE-EXISTING, and its own comment called it:
--    "ten seconds is close enough to that edge to be a coin flip". It lost
--    that flip every time — BOTH passes, not just the deep one. Measured: the
--    2-day "narrow" pass takes 15.6s and the 30-day deep pass ~2 minutes, so
--    the sweep meant to catch under-paid tournaments had been completely dead.
--    600s matches fn_club_rake_rollup_catchup and ca_drain_club_rebuild; the
--    function is idempotent, bounded by p_limit, and tops up only places with
--    exactly one recorded finisher.
--
--    Verified after: a 7-day dry run completes in 53.6s over 32,531 events,
--    truncated:false, and finds SIX events with findings — every one an
--    overpayment the function reports and deliberately never claws back, and
--    total_top_up 0. Nobody is owed money.

ALTER FUNCTION public.fn_requeue_unbanked_cash_rake(integer, integer, integer)
  SET statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.fn_requeue_unbanked_cash_rake(
  p_since_hours integer DEFAULT 6,
  p_min_age_minutes integer DEFAULT 10,
  p_limit integer DEFAULT 200)
RETURNS TABLE (hand_id uuid, table_id uuid, rake numeric, bbj numeric, hand_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public SET statement_timeout = '120s' AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT h.id, h.table_id, h.hand_number, h.created_at,
           COALESCE(h.rake_amount,0) rake, COALESCE(h.bbj_amount,0) bbj,
           COALESCE(h.pot_size, h.rake_amount) pot,
           h.players, h.big_blind
      FROM public.hand_history h
     WHERE h.tournament_id IS NULL
       AND COALESCE(h.rake_amount,0) > 0
       AND h.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_since_hours,6),1))
       AND h.created_at < now() - make_interval(mins => GREATEST(COALESCE(p_min_age_minutes,10),1))
       AND NOT EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = h.id)
       AND NOT EXISTS (SELECT 1 FROM public.pending_fee_distributions p WHERE p.hand_id = h.id)
     ORDER BY h.created_at
     LIMIT GREATEST(COALESCE(p_limit,200),1)
  LOOP
    INSERT INTO public.pending_fee_distributions (
      id, table_id, club_id, hand_id, hand_number, rake, bbj, pot,
      num_players, contributions, tournament_id, big_blind, kind, rake_method)
    SELECT gen_random_uuid(), r.table_id,
           COALESCE(t.club_id, 'fade0000-0000-0000-0000-000000000001'),
           r.id, r.hand_number, r.rake, r.bbj, r.pot,
           GREATEST(COALESCE(jsonb_array_length(r.players), 2), 1),
           -- Equal weights over the dealt-in players; the DEALT_EQUAL stamp
           -- below is what makes the allocator split equally rather than
           -- weight. hand_history carries ENDING STACKS, never per-street
           -- contribution, so a weighted split cannot be reconstructed here
           -- and pretending otherwise would label a guess as truth.
           COALESCE((SELECT jsonb_object_agg(p->>'userId', 1)
                       FROM jsonb_array_elements(r.players) p
                      WHERE p->>'userId' IS NOT NULL), '{}'::jsonb),
           NULL, r.big_blind, 'rake', 'DEALT_EQUAL'
      FROM public.tables t WHERE t.id = r.table_id;

    IF FOUND THEN
      hand_id := r.id; table_id := r.table_id; rake := r.rake; bbj := r.bbj;
      hand_at := r.created_at;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.fn_requeue_unbanked_cash_rake(integer,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_requeue_unbanked_cash_rake(integer,integer,integer) TO service_role;

ALTER FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  SET statement_timeout = '600s';

DO $$
DECLARE v_cfg text[];
BEGIN
  SELECT proconfig INTO v_cfg FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_requeue_unbanked_cash_rake';
  IF NOT (v_cfg::text ILIKE '%statement_timeout=120s%') THEN
    RAISE EXCEPTION 'requeue sweep still has no ceiling: %', v_cfg;
  END IF;
  SELECT proconfig INTO v_cfg FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_tournament_payout_sweep';
  IF NOT (v_cfg::text ILIKE '%statement_timeout=600s%') THEN
    RAISE EXCEPTION 'payout sweep still has no ceiling: %', v_cfg;
  END IF;
END $$;
