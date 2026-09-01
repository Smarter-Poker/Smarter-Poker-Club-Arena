-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831085156; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- A HAND'S RAKE THAT MISSED THE QUEUE NOW HEALS ITSELF
--
-- Phase 2 re-queued 21 lost hands from the 2026-08-30 outage BY HAND. Today's
-- verification found the leak is not a one-off: measured over 24 hours,
-- 17,911 raked cash hands, 20 of them (72.30 chips) have NO rake_records row
-- and are NOT in the queue either, clustered exactly at engine restarts
-- (08-30 08-10h, 08-30 17-18h, 08-31 08h). 0.11% — small, permanent, and
-- growing by roughly a chip an hour with nothing to stop it.
--
-- WHY IT HAPPENS. FeeReconciler.pendingHands is an IN-MEMORY queue drained on
-- shutdown. When the process dies between the inline fee write failing and
-- the drain, the link is gone: nothing on disk remembers the hand owed a fee.
-- The 08:07 cluster shows the split cleanly — four hands have a
-- bbj_contributions row and no rake_records, three have rake_records and no
-- bbj_contributions. Two halves of one write, one restart between them.
--
-- WHY NOTHING HEALED IT. fn_bbj_repair_unbanked heals BBJ *from* rake_records,
-- so it covers exactly one of those two directions. A hand with no
-- rake_records at all is invisible to every existing healer.
--
-- WHAT THIS ADDS. A disk-based sweep: any CASH hand older than the grace with
-- rake_amount > 0, no rake_records row and nothing in the queue is INSERTED
-- into pending_fee_distributions, where the existing reconciler drives it
-- through atomic_distribute_rake — which is hand-gated and idempotent, so a
-- double sweep cannot double-bank.
--
-- ATTRIBUTION IS HONEST ABOUT WHAT IT LOST. hand_history.players carries the
-- dealt-in user ids and their ENDING STACK, never their per-street
-- contribution, so the weighted-contributed split cannot be reconstructed
-- after the fact. The sweep therefore stamps rake_method='DEALT_EQUAL' — the
-- documented legacy method the allocator still implements exactly — and
-- passes each dealt-in player a weight of 1. An equal split among the players
-- who were actually dealt in, labelled as such, is recoverable truth; a
-- weighted split invented from stack sizes would be a fabrication wearing the
-- weighted method's name.
--
-- It never moves chips itself: it only files the claim.
-- ═══════════════════════════════════════════════════════════════════════════

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
           -- Equal weights over the dealt-in players; the method stamp below
           -- is what makes the allocator split equally rather than weight.
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

-- Heal what is outstanding right now.
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

