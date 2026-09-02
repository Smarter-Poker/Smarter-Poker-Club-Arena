-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827215330; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- 20260827191000_trivia_verified_scores.sql
-- ============================================================================
-- TIER:        3
-- AUTHOR:      Codex
-- AFFECTS:     trivia_scores columns/index/policy; award_trivia_run_v2 and
--              fn_trivia_prize_wheel_spin RPCs
-- IRREVERSIBLE: no
--
-- WHY:
--   Browser clients could insert arbitrary scores and turn a forged perfect
--   score into a prize-wheel payout. Daily cap reads also raced across tabs.
--
-- HOW:
--   - Link each score to one server-graded session and revoke browser writes.
--   - Serialize cap enforcement and score/payout writes in one transaction.
--   - Require a submitted linked session before any wheel prize is granted.
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.trivia_scores') IS NULL
       OR to_regclass('public.trivia_sessions') IS NULL THEN
        RAISE EXCEPTION 'pre-flight failed: trivia_scores/trivia_sessions missing';
    END IF;
    IF to_regprocedure('public.award_trivia_run(uuid,integer,integer,integer,integer)') IS NULL
       OR to_regprocedure('public.fn_trivia_prize_wheel_spin(uuid)') IS NULL THEN
        RAISE EXCEPTION 'pre-flight failed: trivia award/wheel RPC missing';
    END IF;
END $$;

ALTER TABLE public.trivia_scores
    ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.trivia_sessions(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS server_verified boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS trivia_scores_session_once
    ON public.trivia_scores (session_id)
    WHERE session_id IS NOT NULL;

DROP POLICY IF EXISTS "Users can insert their own scores" ON public.trivia_scores;
REVOKE INSERT, UPDATE, DELETE ON public.trivia_scores FROM anon, authenticated;
GRANT SELECT ON public.trivia_scores TO anon, authenticated;

-- award_trivia_run_v2 calls the existing atomic payout function and writes the
-- score before the enclosing transaction commits. If the score write fails,
-- the nested payout and session close roll back with it.
CREATE OR REPLACE FUNCTION public.award_trivia_run_v2(
    p_session_id uuid,
    p_score      int,
    p_correct    int,
    p_total      int,
    p_answered   int,
    p_diamonds   int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session  public.trivia_sessions%ROWTYPE;
    v_award    jsonb;
    v_score_id uuid;
    v_existing public.trivia_scores%ROWTYPE;
    v_play_date date := (now() AT TIME ZONE 'America/Chicago')::date;
    v_total_for_stats int;
    v_mode_cap int;
    v_earned_today int;
    v_clamped_diamonds int;
BEGIN
    SELECT * INTO v_session
      FROM public.trivia_sessions
     WHERE id = p_session_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'session_not_found');
    END IF;

    IF v_session.mode IN ('arcade', 'mtt', 'cash', 'icm', 'gto', 'mixed', 'endless', 'survival', 'time-attack')
       AND v_session.entry_state NOT IN ('charged', 'vip', 'continuation') THEN
        RETURN jsonb_build_object('success', false, 'error', 'entry_not_verified');
    END IF;

    v_total_for_stats := CASE
        WHEN v_session.mode IN ('endless', 'time-attack')
            THEN GREATEST(COALESCE(p_answered, 0), COALESCE(p_correct, 0))
        ELSE GREATEST(COALESCE(p_total, 0), COALESCE(p_correct, 0))
    END;

    -- Serialize awards per user/mode/CST-day. The API's earlier cap read is a
    -- useful preview, but only this transaction can close the cross-session
    -- TOCTOU race where two tabs both saw the same remaining allowance.
    PERFORM pg_advisory_xact_lock(hashtextextended(
        v_session.user_id::text || ':' || v_session.mode || ':' || v_play_date::text,
        0
    ));
    v_mode_cap := CASE v_session.mode
        WHEN 'daily' THEN 10 WHEN 'history' THEN 10 WHEN 'rules' THEN 10 WHEN 'pro' THEN 10
        WHEN 'arcade' THEN 40 WHEN 'survival' THEN 80
        WHEN 'mtt' THEN 40 WHEN 'cash' THEN 40 WHEN 'icm' THEN 40 WHEN 'gto' THEN 60
        WHEN 'mixed' THEN 40 WHEN 'endless' THEN 40 WHEN 'time-attack' THEN 40
        ELSE 0 END;
    SELECT COALESCE(SUM(diamonds_awarded), 0) INTO v_earned_today
      FROM public.trivia_sessions
     WHERE user_id = v_session.user_id
       AND mode = v_session.mode
       AND status = 'submitted'
       AND (COALESCE(submitted_at, created_at) AT TIME ZONE 'America/Chicago')::date = v_play_date;
    v_clamped_diamonds := LEAST(
        GREATEST(COALESCE(p_diamonds, 0), 0),
        GREATEST(v_mode_cap - v_earned_today, 0)
    );

    SELECT public.award_trivia_run(
        p_session_id,
        p_score,
        p_correct,
        p_total,
        v_clamped_diamonds
    ) INTO v_award;

    IF COALESCE((v_award->>'success')::boolean, false) IS NOT TRUE THEN
        RETURN v_award;
    END IF;

    -- Daily intentionally keeps one score/spin token per CST day. During the
    -- additive rollout an older client-created row may already occupy that
    -- slot; adopt it into the verified flow only after this server has graded
    -- a real session. Later daily sessions keep the first verified token but
    -- may improve the displayed best score.
    IF v_session.mode = 'daily' THEN
        SELECT * INTO v_existing
          FROM public.trivia_scores
         WHERE user_id = v_session.user_id
           AND mode = 'daily'
           AND play_date = v_play_date
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE;

        IF FOUND THEN
            UPDATE public.trivia_scores
               SET score = GREATEST(score, GREATEST(COALESCE(p_score, 0), 0)),
                   correct_count = CASE WHEN COALESCE(p_score, 0) > score THEN GREATEST(COALESCE(p_correct, 0), 0) ELSE correct_count END,
                   total_questions = CASE WHEN COALESCE(p_score, 0) > score THEN v_total_for_stats ELSE total_questions END,
                   diamonds_earned = GREATEST(diamonds_earned, v_clamped_diamonds),
                   session_id = CASE WHEN server_verified THEN session_id ELSE p_session_id END,
                   server_verified = true
             WHERE id = v_existing.id
            RETURNING id INTO v_score_id;
        ELSE
            INSERT INTO public.trivia_scores (
                user_id, username, mode, score, correct_count, total_questions,
                diamonds_earned, play_date, session_id, server_verified
            )
            SELECT v_session.user_id, p.username, v_session.mode,
                   GREATEST(COALESCE(p_score, 0), 0),
                   GREATEST(COALESCE(p_correct, 0), 0),
                   v_total_for_stats,
                   v_clamped_diamonds,
                   v_play_date, p_session_id, true
              FROM public.profiles p
             WHERE p.id = v_session.user_id
            RETURNING id INTO v_score_id;
        END IF;
    ELSE
        INSERT INTO public.trivia_scores (
            user_id, username, mode, score, correct_count, total_questions,
            diamonds_earned, play_date, session_id, server_verified
        )
        SELECT v_session.user_id, p.username, v_session.mode,
               GREATEST(COALESCE(p_score, 0), 0),
               GREATEST(COALESCE(p_correct, 0), 0),
               v_total_for_stats,
               v_clamped_diamonds,
               v_play_date, p_session_id, true
          FROM public.profiles p
         WHERE p.id = v_session.user_id
        RETURNING id INTO v_score_id;
    END IF;

    IF v_score_id IS NULL THEN
        RAISE EXCEPTION 'profile_not_found_for_trivia_score';
    END IF;

    RETURN v_award || jsonb_build_object('score_id', v_score_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.award_trivia_run_v2(uuid, int, int, int, int, int)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_trivia_run_v2(uuid, int, int, int, int, int)
    TO service_role;

-- Replace the wheel verifier with a linked-session check while retaining the
-- existing roll, inventory credit, multiplier, and idempotency behavior.
CREATE OR REPLACE FUNCTION public.fn_trivia_prize_wheel_spin(p_score_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user     uuid := (SELECT auth.uid());
    v_score    record;
    v_existing public.trivia_prize_wheel_spins%ROWTYPE;
    v_roll     integer;
    v_prize_id text;
    v_type     text;
    v_base     integer;
    v_streak   integer := 0;
    v_mult     numeric(4,2) := 1;
    v_amount   integer;
    v_res      jsonb;
    v_has_rpc  boolean;
BEGIN
    IF (SELECT auth.role()) = 'service_role' THEN
        SELECT s.user_id INTO v_user FROM public.trivia_scores s WHERE s.id = p_score_id;
    END IF;
    IF v_user IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT s.id, s.user_id, s.correct_count, s.total_questions, s.created_at,
           s.mode, s.session_id, s.server_verified
      INTO v_score
      FROM public.trivia_scores s
     WHERE s.id = p_score_id
       FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'score_not_found'); END IF;
    IF v_score.user_id IS DISTINCT FROM v_user THEN RETURN jsonb_build_object('success', false, 'error', 'not_your_score'); END IF;
    IF v_score.server_verified IS NOT TRUE OR v_score.session_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM public.trivia_sessions ts
             WHERE ts.id = v_score.session_id
               AND ts.user_id = v_user
               AND ts.status = 'submitted'
               AND ts.correct_count = v_score.correct_count
       ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'score_not_server_verified');
    END IF;
    IF COALESCE(v_score.total_questions, 0) < 5
       OR v_score.correct_count IS DISTINCT FROM v_score.total_questions THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_perfect_game');
    END IF;
    IF v_score.created_at < now() - interval '30 minutes' THEN
        RETURN jsonb_build_object('success', false, 'error', 'spin_window_expired');
    END IF;

    SELECT * INTO v_existing FROM public.trivia_prize_wheel_spins WHERE score_id = p_score_id;
    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'deduped', true,
            'prize_id', v_existing.prize_id, 'prize_type', v_existing.prize_type,
            'prize_amount', v_existing.prize_amount, 'multiplier', v_existing.multiplier);
    END IF;

    v_roll := floor(random() * 100)::int;
    IF    v_roll < 30 THEN v_prize_id := 'diamond_5';     v_type := 'diamonds';      v_base := 5;
    ELSIF v_roll < 55 THEN v_prize_id := 'diamond_10';    v_type := 'diamonds';      v_base := 10;
    ELSIF v_roll < 70 THEN v_prize_id := 'diamond_25';    v_type := 'diamonds';      v_base := 25;
    ELSIF v_roll < 80 THEN v_prize_id := 'diamond_50';    v_type := 'diamonds';      v_base := 50;
    ELSIF v_roll < 85 THEN v_prize_id := 'diamond_100';   v_type := 'diamonds';      v_base := 100;
    ELSIF v_roll < 93 THEN v_prize_id := 'streak_shield'; v_type := 'streak_shield'; v_base := 1;
    ELSIF v_roll < 98 THEN v_prize_id := 'free_entry';    v_type := 'arcade_ticket'; v_base := 1;
    ELSE                   v_prize_id := 'mystery';       v_type := 'diamonds';      v_base := 15;
    END IF;

    SELECT COALESCE(current_streak, 0) INTO v_streak
      FROM public.trivia_streaks WHERE user_id = v_user;
    v_mult := CASE
        WHEN v_streak >= 100 THEN 5.0 WHEN v_streak >= 30 THEN 3.0
        WHEN v_streak >= 14 THEN 2.5 WHEN v_streak >= 7 THEN 2.0 ELSE 1.0 END;
    IF v_type = 'diamonds' THEN v_amount := floor(v_base * v_mult)::int;
    ELSE v_amount := v_base; v_mult := 1; END IF;

    BEGIN
        INSERT INTO public.trivia_prize_wheel_spins
            (user_id, score_id, prize_id, prize_type, prize_amount, multiplier)
        VALUES (v_user, p_score_id, v_prize_id, v_type, v_amount, v_mult);
    EXCEPTION WHEN unique_violation THEN
        SELECT * INTO v_existing FROM public.trivia_prize_wheel_spins WHERE score_id = p_score_id;
        RETURN jsonb_build_object('success', true, 'deduped', true,
            'prize_id', v_existing.prize_id, 'prize_type', v_existing.prize_type,
            'prize_amount', v_existing.prize_amount, 'multiplier', v_existing.multiplier);
    END;

    IF v_type = 'diamonds' AND v_amount > 0 THEN
        v_has_rpc := EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'add_diamonds_to_balance');
        IF v_has_rpc THEN
            EXECUTE 'SELECT public.add_diamonds_to_balance($1,$2,$3,$4,$5)'
               INTO v_res USING v_user, v_amount, 'trivia_prize_wheel',
                    'Prize Wheel - ' || v_prize_id, 'trivia_wheel_' || p_score_id::text;
        ELSE
            UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) + v_amount WHERE id = v_user;
            v_res := jsonb_build_object('success', true);
        END IF;
    ELSE
        INSERT INTO public.trivia_user_items AS i (user_id, item_type, quantity, created_at, updated_at)
        VALUES (v_user, v_type, v_amount, now(), now())
        ON CONFLICT (user_id, item_type) DO UPDATE
            SET quantity = i.quantity + v_amount, updated_at = now();
        v_res := jsonb_build_object('success', true);
    END IF;

    RETURN jsonb_build_object('success', true, 'deduped', false,
        'prize_id', v_prize_id, 'prize_type', v_type,
        'prize_amount', v_amount, 'multiplier', v_mult, 'credit', v_res);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_trivia_prize_wheel_spin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trivia_prize_wheel_spin(uuid) TO authenticated, service_role;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'trivia_scores'
           AND column_name IN ('session_id', 'server_verified')
         GROUP BY table_schema, table_name HAVING count(*) = 2
    ) THEN
        RAISE EXCEPTION 'post-apply failed: verified score columns missing';
    END IF;
    IF to_regprocedure('public.award_trivia_run_v2(uuid,integer,integer,integer,integer,integer)') IS NULL THEN
        RAISE EXCEPTION 'post-apply failed: award_trivia_run_v2 missing';
    END IF;
    IF has_function_privilege('anon', 'public.award_trivia_run_v2(uuid,integer,integer,integer,integer,integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.award_trivia_run_v2(uuid,integer,integer,integer,integer,integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'post-apply failed: browser role can award trivia run';
    END IF;
    IF has_table_privilege('anon', 'public.trivia_scores', 'INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'public.trivia_scores', 'INSERT,UPDATE,DELETE') THEN
        RAISE EXCEPTION 'post-apply failed: browser role can mutate trivia_scores';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ROLLBACK (apply as a new migration; restores the former client-write policy)
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.award_trivia_run_v2(uuid, integer, integer, integer, integer, integer);
-- DROP INDEX IF EXISTS public.trivia_scores_session_once;
-- ALTER TABLE public.trivia_scores DROP COLUMN IF EXISTS server_verified;
-- ALTER TABLE public.trivia_scores DROP COLUMN IF EXISTS session_id;
-- CREATE POLICY "Users can insert their own scores" ON public.trivia_scores
--   FOR INSERT TO PUBLIC WITH CHECK (auth.uid() = user_id);
-- GRANT INSERT ON public.trivia_scores TO anon, authenticated;
-- COMMIT;

