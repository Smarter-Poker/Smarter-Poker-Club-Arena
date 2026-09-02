-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828003306; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Trivia phase 7: make exposure, correctness, mastery, daily completion and
-- skip telemetry consequences of verified settlement instead of browser writes.
BEGIN;

ALTER TABLE public.trivia_sessions
    ADD COLUMN IF NOT EXISTS stats_recorded_at timestamptz;

COMMENT ON COLUMN public.trivia_sessions.stats_recorded_at IS
    'Set atomically after settlement-derived history, mastery, daily-play and skip telemetry are persisted.';

CREATE TABLE IF NOT EXISTS public.trivia_question_result_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    question_id uuid NOT NULL REFERENCES public.trivia_questions(id) ON DELETE CASCADE,
    mode text NOT NULL,
    source_type text NOT NULL CHECK (source_type IN ('session', 'tournament_round')),
    source_id uuid NOT NULL,
    display_index integer,
    original_index integer,
    was_correct boolean,
    was_skipped boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_type, source_id, user_id, question_id)
);

ALTER TABLE public.trivia_question_result_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trivia_question_result_events_owner_select ON public.trivia_question_result_events;
CREATE POLICY trivia_question_result_events_owner_select
    ON public.trivia_question_result_events FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS trivia_question_result_events_service_all ON public.trivia_question_result_events;
CREATE POLICY trivia_question_result_events_service_all
    ON public.trivia_question_result_events FOR ALL TO service_role
    USING (true) WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE ON public.trivia_question_result_events FROM anon, authenticated;
GRANT SELECT ON public.trivia_question_result_events TO authenticated;
CREATE INDEX IF NOT EXISTS trivia_question_result_events_user_created_idx
    ON public.trivia_question_result_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trivia_question_result_events_question_idx
    ON public.trivia_question_result_events (question_id, created_at DESC);

-- Existing history writes happen at serve time and settlement later changes
-- was_correct. Count an exposure only when seen_at changes, and count a correct
-- answer only on the transition to TRUE. This avoids double-counting the
-- serve-time INSERT plus the settlement-time UPDATE.
CREATE OR REPLACE FUNCTION public.update_question_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_shown_delta integer := 0;
    v_seen_at timestamptz;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_shown_delta := 1;
        v_seen_at := NEW.seen_at;
    ELSE
        v_shown_delta := CASE WHEN NEW.seen_at IS DISTINCT FROM OLD.seen_at THEN 1 ELSE 0 END;
        v_seen_at := GREATEST(COALESCE(OLD.seen_at, NEW.seen_at), NEW.seen_at);
    END IF;

    IF v_shown_delta <> 0 THEN
        UPDATE public.trivia_questions
           SET last_used_at = GREATEST(COALESCE(last_used_at, v_seen_at), v_seen_at),
               use_count = GREATEST(COALESCE(use_count, 0) + v_shown_delta, 0),
               times_shown = GREATEST(COALESCE(times_shown, 0) + v_shown_delta, 0)
         WHERE id = NEW.question_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_update_question_usage ON public.trivia_user_question_history;
CREATE TRIGGER trigger_update_question_usage
    AFTER INSERT ON public.trivia_user_question_history
    FOR EACH ROW EXECUTE FUNCTION public.update_question_usage();

DROP TRIGGER IF EXISTS trigger_update_question_usage_upd ON public.trivia_user_question_history;
CREATE TRIGGER trigger_update_question_usage_upd
    AFTER UPDATE ON public.trivia_user_question_history
    FOR EACH ROW
    WHEN (NEW.seen_at IS DISTINCT FROM OLD.seen_at
       OR NEW.was_correct IS DISTINCT FROM OLD.was_correct)
    EXECUTE FUNCTION public.update_question_usage();

CREATE OR REPLACE FUNCTION public.finalize_trivia_session_stats_v3(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session public.trivia_sessions%ROWTYPE;
    v_question_id uuid;
    v_category text;
    v_correct_index integer;
    v_answer jsonb;
    v_permutation jsonb;
    v_display_index integer;
    v_original_index integer;
    v_was_correct boolean;
    v_event_id uuid;
    v_answered integer := 0;
    v_correct integer := 0;
    v_skipped integer := 0;
    v_play_date date;
    v_streak integer := 0;
BEGIN
    SELECT * INTO v_session
      FROM public.trivia_sessions
     WHERE id = p_session_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'session_not_found');
    END IF;
    IF v_session.status <> 'submitted' OR v_session.settlement_result IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'session_not_settled');
    END IF;
    IF v_session.stats_recorded_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'deduped', true);
    END IF;

    -- Claim before the derived writes. Any later error rolls the claim back,
    -- making a retry safe and complete.
    UPDATE public.trivia_sessions
       SET stats_recorded_at = now()
     WHERE id = p_session_id;

    FOREACH v_question_id IN ARRAY COALESCE(v_session.question_ids, ARRAY[]::uuid[])
    LOOP
        SELECT category, correct_index
          INTO v_category, v_correct_index
          FROM public.trivia_questions
         WHERE id = v_question_id;
        IF NOT FOUND THEN
            CONTINUE;
        END IF;

        v_answer := COALESCE(v_session.answers, '{}'::jsonb) -> v_question_id::text;
        v_display_index := CASE
            WHEN v_answer IS NOT NULL AND (v_answer->>'d') ~ '^-?[0-9]+$'
                THEN (v_answer->>'d')::integer
            ELSE NULL
        END;
        v_permutation := COALESCE(v_session.permutations, '{}'::jsonb) -> v_question_id::text;
        v_original_index := NULL;
        IF v_display_index IS NOT NULL
           AND v_display_index >= 0
           AND jsonb_typeof(v_permutation) = 'array'
           AND v_display_index < jsonb_array_length(v_permutation)
           AND (v_permutation->>v_display_index) ~ '^[0-9]+$' THEN
            v_original_index := (v_permutation->>v_display_index)::integer;
        END IF;

        v_was_correct := CASE
            WHEN v_original_index IS NULL OR v_correct_index IS NULL THEN NULL
            ELSE v_original_index = v_correct_index
        END;

        v_event_id := NULL;
        INSERT INTO public.trivia_question_result_events
            (user_id, question_id, mode, source_type, source_id,
             display_index, original_index, was_correct, was_skipped)
        VALUES
            (v_session.user_id, v_question_id, v_session.mode, 'session', v_session.id,
             v_display_index, v_original_index, v_was_correct,
             v_answer IS NOT NULL AND COALESCE(v_display_index, -1) < 0)
        ON CONFLICT (source_type, source_id, user_id, question_id) DO NOTHING
        RETURNING id INTO v_event_id;
        IF v_event_id IS NULL THEN
            CONTINUE;
        END IF;

        INSERT INTO public.trivia_user_question_history AS h
            (user_id, question_id, seen_at, was_correct, mode)
        VALUES
            (v_session.user_id, v_question_id, COALESCE(v_session.created_at, now()),
             v_was_correct, v_session.mode)
        ON CONFLICT (user_id, question_id) DO UPDATE
            SET was_correct = EXCLUDED.was_correct,
                mode = EXCLUDED.mode;

        IF v_answer IS NOT NULL AND COALESCE(v_display_index, -1) < 0 THEN
            UPDATE public.trivia_questions
               SET skipped_count = COALESCE(skipped_count, 0) + 1
             WHERE id = v_question_id;
            v_skipped := v_skipped + 1;
        END IF;

        IF v_original_index IS NOT NULL THEN
            v_answered := v_answered + 1;
            IF v_was_correct IS TRUE THEN
                v_correct := v_correct + 1;
                UPDATE public.trivia_questions
                   SET times_correct = COALESCE(times_correct, 0) + 1
                 WHERE id = v_question_id;
            END IF;

            INSERT INTO public.trivia_category_mastery AS m
                (user_id, category, total_answered, correct_count, mastery_level, updated_at)
            VALUES
                (v_session.user_id, COALESCE(v_category, 'general'), 1,
                 CASE WHEN v_was_correct IS TRUE THEN 1 ELSE 0 END,
                 CASE WHEN v_was_correct IS TRUE THEN 10 ELSE 1 END, now())
            ON CONFLICT (user_id, category) DO UPDATE SET
                total_answered = m.total_answered + 1,
                correct_count = m.correct_count + EXCLUDED.correct_count,
                mastery_level = LEAST(10, GREATEST(1,
                    floor(((m.correct_count + EXCLUDED.correct_count)::numeric
                        / NULLIF(m.total_answered + 1, 0)) * 10)::integer + 1)),
                updated_at = now();
        END IF;
    END LOOP;

    IF v_session.mode = 'daily' THEN
        v_play_date := (COALESCE(v_session.submitted_at, now())
            AT TIME ZONE 'America/Chicago')::date;
        SELECT COALESCE(current_streak, 0) INTO v_streak
          FROM public.trivia_streaks
         WHERE user_id = v_session.user_id;

        INSERT INTO public.daily_trivia_plays AS d
            (user_id, played_date, was_correct, streak_at_time, created_at)
        VALUES
            (v_session.user_id, v_play_date, v_correct > 0, v_streak, now())
        ON CONFLICT (user_id, played_date) DO UPDATE SET
            was_correct = d.was_correct OR EXCLUDED.was_correct,
            streak_at_time = GREATEST(COALESCE(d.streak_at_time, 0), EXCLUDED.streak_at_time);
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'deduped', false,
        'answered', v_answered,
        'correct', v_correct,
        'skipped', v_skipped
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_trivia_session_stats_v3(uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_trivia_session_stats_v3(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.record_trivia_tournament_question_results_v3(
    p_user_id uuid,
    p_round_id uuid,
    p_results jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row jsonb;
    v_question_id uuid;
    v_category text;
    v_display integer;
    v_original integer;
    v_correct boolean;
    v_skipped boolean;
    v_event_id uuid;
    v_inserted integer := 0;
BEGIN
    IF p_user_id IS NULL OR p_round_id IS NULL OR jsonb_typeof(p_results) <> 'array' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_arguments');
    END IF;
    IF jsonb_array_length(p_results) > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_many_results');
    END IF;

    FOR v_row IN SELECT value FROM jsonb_array_elements(p_results)
    LOOP
        BEGIN
            v_question_id := (v_row->>'question_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            CONTINUE;
        END;
        SELECT category INTO v_category
          FROM public.trivia_questions
         WHERE id = v_question_id;
        IF NOT FOUND THEN CONTINUE; END IF;

        v_display := CASE WHEN (v_row->>'display_index') ~ '^-?[0-9]+$'
            THEN (v_row->>'display_index')::integer ELSE NULL END;
        v_original := CASE WHEN (v_row->>'original_index') ~ '^[0-9]+$'
            THEN (v_row->>'original_index')::integer ELSE NULL END;
        v_correct := CASE WHEN jsonb_typeof(v_row->'was_correct') = 'boolean'
            THEN (v_row->>'was_correct')::boolean ELSE NULL END;
        v_skipped := COALESCE((v_row->>'was_skipped')::boolean, false);

        v_event_id := NULL;
        INSERT INTO public.trivia_question_result_events
            (user_id, question_id, mode, source_type, source_id,
             display_index, original_index, was_correct, was_skipped)
        VALUES
            (p_user_id, v_question_id, 'tournaments', 'tournament_round', p_round_id,
             v_display, v_original, v_correct, v_skipped)
        ON CONFLICT (source_type, source_id, user_id, question_id) DO NOTHING
        RETURNING id INTO v_event_id;
        IF v_event_id IS NULL THEN CONTINUE; END IF;
        v_inserted := v_inserted + 1;

        INSERT INTO public.trivia_user_question_history AS h
            (user_id, question_id, seen_at, was_correct, mode)
        VALUES (p_user_id, v_question_id, now(), v_correct, 'tournaments')
        ON CONFLICT (user_id, question_id) DO UPDATE SET
            seen_at = EXCLUDED.seen_at,
            was_correct = EXCLUDED.was_correct,
            mode = EXCLUDED.mode;

        IF v_skipped THEN
            UPDATE public.trivia_questions
               SET skipped_count = COALESCE(skipped_count, 0) + 1
             WHERE id = v_question_id;
        END IF;
        IF v_correct IS TRUE THEN
            UPDATE public.trivia_questions
               SET times_correct = COALESCE(times_correct, 0) + 1
             WHERE id = v_question_id;
        END IF;
        IF v_original IS NOT NULL THEN
            INSERT INTO public.trivia_category_mastery AS m
                (user_id, category, total_answered, correct_count, mastery_level, updated_at)
            VALUES
                (p_user_id, COALESCE(v_category, 'general'), 1,
                 CASE WHEN v_correct IS TRUE THEN 1 ELSE 0 END,
                 CASE WHEN v_correct IS TRUE THEN 10 ELSE 1 END, now())
            ON CONFLICT (user_id, category) DO UPDATE SET
                total_answered = m.total_answered + 1,
                correct_count = m.correct_count + EXCLUDED.correct_count,
                mastery_level = LEAST(10, GREATEST(1,
                    floor(((m.correct_count + EXCLUDED.correct_count)::numeric
                        / NULLIF(m.total_answered + 1, 0)) * 10)::integer + 1)),
                updated_at = now();
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'inserted', v_inserted,
        'deduped', v_inserted = 0);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_trivia_tournament_question_results_v3(uuid,uuid,jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_trivia_tournament_question_results_v3(uuid,uuid,jsonb)
    TO service_role;

-- Claim the bracket slot and its verified answer-derived projections in one
-- transaction. The underlying matchup function obtains the round-row lock and
-- is the idempotency gate. If analytics persistence raises or rejects, the
-- bracket mutation rolls back with it.
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

    RETURN v_claim || jsonb_build_object('stats', v_stats);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_trivia_round_submit_verified_v3(uuid,uuid,integer,integer,jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trivia_round_submit_verified_v3(uuid,uuid,integer,integer,jsonb)
    TO service_role;

CREATE OR REPLACE FUNCTION public.trg_finalize_trivia_session_stats_v3()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result jsonb;
BEGIN
    IF NEW.settlement_result IS NOT NULL
       AND OLD.settlement_result IS NULL
       AND NEW.status = 'submitted' THEN
        SELECT public.finalize_trivia_session_stats_v3(NEW.id) INTO v_result;
        IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE THEN
            RAISE EXCEPTION 'trivia stats finalization rejected: %',
                COALESCE(v_result->>'error', 'unknown');
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trivia_session_stats_v3 ON public.trivia_sessions;
CREATE TRIGGER trg_trivia_session_stats_v3
    AFTER UPDATE OF settlement_result ON public.trivia_sessions
    FOR EACH ROW EXECUTE FUNCTION public.trg_finalize_trivia_session_stats_v3();

-- Remove legacy duplicate daily rows before making the one-play-per-day rule
-- an enforced invariant in every environment.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY user_id, played_date
               ORDER BY created_at DESC NULLS LAST, id DESC
           ) AS rn
      FROM public.daily_trivia_plays
)
DELETE FROM public.daily_trivia_plays d
 USING ranked r
 WHERE d.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS daily_trivia_plays_user_date_uidx
    ON public.daily_trivia_plays (user_id, played_date);

-- Browser reads remain owner-scoped. All writes are now performed through
-- authenticated API routes using service_role and verified server state.
DO $$
DECLARE
    v_table text;
    v_policy record;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'trivia_user_question_history',
        'trivia_category_mastery',
        'daily_trivia_plays'
    ] LOOP
        FOR v_policy IN
            SELECT policyname
              FROM pg_policies
             WHERE schemaname = 'public' AND tablename = v_table
        LOOP
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_policy.policyname, v_table);
        END LOOP;
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id)',
            v_table || '_owner_select', v_table
        );
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
            v_table || '_service_all', v_table
        );
    END LOOP;
END $$;

REVOKE INSERT, UPDATE, DELETE ON public.trivia_user_question_history FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.trivia_category_mastery FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.daily_trivia_plays FROM anon, authenticated;
GRANT SELECT ON public.trivia_user_question_history TO authenticated;
GRANT SELECT ON public.trivia_category_mastery TO authenticated;
GRANT SELECT ON public.daily_trivia_plays TO authenticated;

CREATE TABLE IF NOT EXISTS public.trivia_economy_audit_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL CHECK (status IN ('healthy', 'exceptions')),
    exception_count integer NOT NULL DEFAULT 0,
    findings jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trivia_economy_audit_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trivia_economy_audit_runs_service_all ON public.trivia_economy_audit_runs;
CREATE POLICY trivia_economy_audit_runs_service_all
    ON public.trivia_economy_audit_runs FOR ALL TO service_role
    USING (true) WITH CHECK (true);
REVOKE ALL ON public.trivia_economy_audit_runs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.run_trivia_economy_audit_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_missing_session_awards integer;
    v_mismatched_session_awards integer;
    v_missing_wheel_credits integer;
    v_mismatched_wheel_credits integer;
    v_missing_wheel_items integer;
    v_missing_exact_refs integer;
    v_duplicate_refs integer;
    v_total integer;
    v_findings jsonb;
    v_run_id uuid;
BEGIN
    SELECT count(*) INTO v_missing_session_awards
      FROM public.trivia_sessions s
     WHERE s.status = 'submitted'
       AND COALESCE(s.diamonds_awarded, 0) > 0
       AND NOT EXISTS (
           SELECT 1 FROM public.diamond_transactions d
            WHERE d.user_id = s.user_id
              AND d.reference_id = 'trivia_session_' || s.id::text
       );

    SELECT count(*) INTO v_mismatched_session_awards
      FROM public.trivia_sessions s
      JOIN public.diamond_transactions d
        ON d.user_id = s.user_id
       AND d.reference_id = 'trivia_session_' || s.id::text
     WHERE s.status = 'submitted'
       AND d.amount IS DISTINCT FROM s.diamonds_awarded;

    SELECT count(*) INTO v_missing_wheel_credits
      FROM public.trivia_prize_wheel_spins w
     WHERE w.prize_type = 'diamonds'
       AND NOT EXISTS (
           SELECT 1 FROM public.diamond_transactions d
            WHERE d.user_id = w.user_id
              AND d.reference_id = 'trivia_wheel_' || w.score_id::text
       );

    SELECT count(*) INTO v_mismatched_wheel_credits
      FROM public.trivia_prize_wheel_spins w
      JOIN public.diamond_transactions d
        ON d.user_id = w.user_id
       AND d.reference_id = 'trivia_wheel_' || w.score_id::text
     WHERE w.prize_type = 'diamonds'
       AND d.amount IS DISTINCT FROM w.prize_amount;

    SELECT count(*) INTO v_missing_wheel_items
      FROM public.trivia_prize_wheel_spins w
     WHERE w.prize_type <> 'diamonds'
       AND NOT EXISTS (
           SELECT 1 FROM public.trivia_item_transactions i
            WHERE i.user_id = w.user_id
              AND i.reference_id = 'trivia_wheel_item_' || w.score_id::text
       );

    SELECT count(*) INTO v_missing_exact_refs
      FROM public.diamond_transactions d
     WHERE d.created_at >= now() - interval '30 days'
       AND d.transaction_type IN (
           'trivia_run', 'trivia_daily_bonus', 'trivia_prize_wheel',
           'pvp_stake', 'pvp_refund', 'pvp_win',
           'tournament_entry', 'tournament_entry_refund',
           'tournament_cancel_refund', 'tournament_prize'
       )
       AND NULLIF(btrim(d.reference_id), '') IS NULL;

    SELECT count(*) INTO v_duplicate_refs
      FROM (
          SELECT user_id, reference_id
            FROM public.diamond_transactions
           WHERE reference_id IS NOT NULL
             AND created_at >= now() - interval '30 days'
           GROUP BY user_id, reference_id
          HAVING count(*) > 1
      ) duplicate_group;

    v_total := v_missing_session_awards + v_mismatched_session_awards
        + v_missing_wheel_credits + v_mismatched_wheel_credits
        + v_missing_wheel_items + v_missing_exact_refs + v_duplicate_refs;
    v_findings := jsonb_build_object(
        'missing_session_awards', v_missing_session_awards,
        'mismatched_session_awards', v_mismatched_session_awards,
        'missing_wheel_credits', v_missing_wheel_credits,
        'mismatched_wheel_credits', v_mismatched_wheel_credits,
        'missing_wheel_items', v_missing_wheel_items,
        'missing_exact_references_30d', v_missing_exact_refs,
        'duplicate_user_references_30d', v_duplicate_refs
    );

    INSERT INTO public.trivia_economy_audit_runs(status, exception_count, findings)
    VALUES (CASE WHEN v_total = 0 THEN 'healthy' ELSE 'exceptions' END, v_total, v_findings)
    RETURNING id INTO v_run_id;

    RETURN jsonb_build_object(
        'success', true,
        'healthy', v_total = 0,
        'run_id', v_run_id,
        'exception_count', v_total,
        'findings', v_findings
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.run_trivia_economy_audit_v1()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_trivia_economy_audit_v1() TO service_role;

-- The wheel is now mediated by an authenticated, rate-limited API route.
-- service_role rechecks score ownership before calling this RPC; browsers no
-- longer execute a value-moving SECURITY DEFINER function directly.
REVOKE EXECUTE ON FUNCTION public.fn_trivia_prize_wheel_spin(uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trivia_prize_wheel_spin(uuid) TO service_role;

-- Remove a live-schema drift policy that exposed every PvP match to every
-- signed-in user. The participant policy is the sole browser read path.
DROP POLICY IF EXISTS "Users can view all matches" ON public.trivia_pvp_matches;
DROP POLICY IF EXISTS "Users can view their matches" ON public.trivia_pvp_matches;
DROP POLICY IF EXISTS "Users can view own matches" ON public.trivia_pvp_matches;
DROP POLICY IF EXISTS "Participants can view their matches" ON public.trivia_pvp_matches;
CREATE POLICY "Participants can view their matches"
    ON public.trivia_pvp_matches FOR SELECT TO authenticated
    USING (
        (SELECT auth.uid()) = player1_id
        OR (SELECT auth.uid()) = player2_id
        OR (SELECT auth.uid()) = challenger_id
        OR (SELECT auth.uid()) = opponent_id
    );

NOTIFY pgrst, 'reload schema';
COMMIT;

