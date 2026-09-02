-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828030554; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Phase 7 follow-up: bracket state, answer-derived analytics, and cumulative
-- entry totals must share one transaction. A post-RPC HTTP write could fail
-- after the matchup slot was already claimed, making the total unrecoverable
-- on an idempotent retry.

CREATE OR REPLACE FUNCTION public.fn_trivia_round_submit_verified_v3(
    p_round_id uuid,
    p_user_id uuid,
    p_score integer,
    p_time integer,
    p_results jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_claim jsonb;
    v_stats jsonb;
    v_entry_score integer;
    v_entry_time integer;
BEGIN
    IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'service_role required';
    END IF;

    SELECT public.fn_trivia_round_set_matchup_score(
        p_round_id, p_user_id, p_score, p_time
    ) INTO v_claim;

    IF COALESCE((v_claim->>'applied')::boolean, false) IS NOT TRUE THEN
        RETURN v_claim;
    END IF;

    SELECT public.record_trivia_tournament_question_results_v3(
        p_user_id, p_round_id, p_results
    ) INTO v_stats;
    IF COALESCE((v_stats->>'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'tournament stats rejected: %',
            COALESCE(v_stats->>'error', 'unknown');
    END IF;

    UPDATE public.trivia_tournament_entries AS e
       SET score = COALESCE(e.score, 0) + GREATEST(COALESCE(p_score, 0), 0),
           time_spent = COALESCE(e.time_spent, 0) + GREATEST(COALESCE(p_time, 0), 0),
           completed_at = now()
      FROM public.trivia_tournament_rounds AS r
     WHERE r.id = p_round_id
       AND e.tournament_id = r.tournament_id
       AND e.user_id = p_user_id
    RETURNING e.score, e.time_spent INTO v_entry_score, v_entry_time;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament entry missing for round submission';
    END IF;

    RETURN v_claim || jsonb_build_object(
        'stats', v_stats,
        'entry_score', v_entry_score,
        'entry_time', v_entry_time
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_trivia_round_submit_verified_v3(uuid,uuid,integer,integer,jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trivia_round_submit_verified_v3(uuid,uuid,integer,integer,jsonb)
    TO service_role;

