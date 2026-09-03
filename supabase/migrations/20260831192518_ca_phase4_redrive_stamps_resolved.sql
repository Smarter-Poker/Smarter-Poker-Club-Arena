-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831192518; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ca_phase4_redrive_stamps_resolved (prod 20260831192518). Canonical body lives in prod schema_migrations -
-- replace this marker byte-exact via scripts/dev/export-applied-migrations.sh.
-- Phase 4: fn_redrive_unbanked_rake stamps resolved_at; banked queue rows were rescanned forever.

-- ZERO-DRIFT phase 4 (found during the 19:23 repair): fn_redrive_unbanked_rake
-- never stamped resolved_at, so successfully banked queue rows were rescanned
-- forever. Now: a redriven or already-banked row is stamped resolved; a failed
-- attempt records the error and bumps attempts.
CREATE OR REPLACE FUNCTION public.fn_redrive_unbanked_rake(p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_hand uuid; v_ok int := 0; v_failed int := 0; v_already int := 0;
BEGIN
  FOR r IN SELECT p.* FROM public.pending_fee_distributions p
           WHERE p.resolved_at IS NULL AND p.kind = 'rake'
           ORDER BY p.created_at
           LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  LOOP
    v_hand := r.hand_id;
    IF v_hand IS NULL AND r.hand_number >= 1000000 THEN
      SELECT id INTO v_hand FROM public.hand_history WHERE hand_number = r.hand_number LIMIT 1;
    END IF;
    IF v_hand IS NOT NULL AND EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = v_hand) THEN
      UPDATE public.pending_fee_distributions
         SET resolved_at = now(), last_error = COALESCE(last_error, '') || ' [already banked]'
       WHERE id = r.id;
      v_already := v_already + 1;
      CONTINUE;
    END IF;
    BEGIN
      PERFORM public.atomic_distribute_rake(
        r.table_id, r.club_id, v_hand, r.hand_number::integer, r.rake, r.bbj,
        r.pot, r.num_players, r.contributions, r.tournament_id,
        r.returned_uncalled, COALESCE(r.rake_method, 'DEALT_EQUAL'));
      UPDATE public.pending_fee_distributions
         SET resolved_at = now(), attempts = COALESCE(attempts, 0) + 1, last_attempt_at = now()
       WHERE id = r.id;
      v_ok := v_ok + 1;
    EXCEPTION WHEN others THEN
      UPDATE public.pending_fee_distributions
         SET attempts = COALESCE(attempts, 0) + 1, last_attempt_at = now(),
             last_error = left(SQLERRM, 500)
       WHERE id = r.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'redriven', v_ok,
    'already_banked', v_already, 'failed', v_failed);
END $function$;

-- Stamp the rows banked before this fix.
UPDATE public.pending_fee_distributions p
   SET resolved_at = now(), last_error = COALESCE(p.last_error, '') || ' [already banked]'
 WHERE p.resolved_at IS NULL AND p.kind = 'rake'
   AND EXISTS (SELECT 1 FROM public.hand_history hh
               JOIN public.rake_records rr ON rr.hand_id = hh.id
               WHERE hh.hand_number = p.hand_number);
