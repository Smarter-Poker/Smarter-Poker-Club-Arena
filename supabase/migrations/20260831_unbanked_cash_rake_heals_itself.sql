-- Repo copy of production migration `unbanked_cash_rake_heals_itself`
-- (applied 2026-08-31 via Supabase MCP). See
-- docs/changelog/2026-08-31-phase2-verification-what-i-got-wrong.md.
--
-- A HAND'S RAKE THAT MISSED THE QUEUE NOW HEALS ITSELF.
--
-- Phase 2 re-queued 21 lost hands from the 2026-08-30 outage BY HAND. The
-- verification pass found the leak is not a one-off: measured over 24 hours,
-- 17,911 raked cash hands, 20 of them (72.30 chips) with NO rake_records row
-- and nothing in the queue either, clustered exactly at engine restarts.
--
-- WHY: FeeReconciler.pendingHands is an IN-MEMORY queue drained on shutdown.
-- A process death between the inline fee write failing and the drain loses
-- the claim. The 08:07 cluster shows the split cleanly: four hands with a
-- bbj_contributions row and no rake_records, three the reverse.
--
-- WHY NOTHING HEALED IT: fn_bbj_repair_unbanked heals BBJ *from* rake_records,
-- so a hand with no rake_records at all is invisible to every healer.
--
-- The sweep only FILES THE CLAIM; the reconciler banks it through the
-- hand-gated, idempotent atomic_distribute_rake. Attribution is stamped
-- DEALT_EQUAL because hand_history.players carries ending stacks, never
-- per-street contribution — an equal split among the dealt-in players,
-- labelled as such, rather than weights invented from stack sizes.

CREATE OR REPLACE FUNCTION public.fn_requeue_unbanked_cash_rake(
  p_since_hours integer DEFAULT 48,
  p_min_age_minutes integer DEFAULT 10,
  p_limit integer DEFAULT 200)
RETURNS TABLE (hand_id uuid, table_id uuid, rake numeric, bbj numeric, hand_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
       AND h.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_since_hours,48),1))
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

DO $$
DECLARE n int; chips numeric;
BEGIN
  SELECT count(*), COALESCE(round(sum(rake),2),0) INTO n, chips
    FROM public.fn_requeue_unbanked_cash_rake(48, 10, 500);
  RAISE NOTICE 're-queued % unbanked cash hand(s), % chips', n, chips;
END $$;

DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.hand_history h
   WHERE h.tournament_id IS NULL
     AND COALESCE(h.rake_amount,0) > 0
     AND h.created_at > now() - interval '48 hours'
     AND h.created_at < now() - interval '10 minutes'
     AND NOT EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = h.id)
     AND NOT EXISTS (SELECT 1 FROM public.pending_fee_distributions p WHERE p.hand_id = h.id);
  IF v_left > 0 THEN
    RAISE EXCEPTION '% unbanked cash hands remain unqueued after the sweep', v_left;
  END IF;
END $$;
