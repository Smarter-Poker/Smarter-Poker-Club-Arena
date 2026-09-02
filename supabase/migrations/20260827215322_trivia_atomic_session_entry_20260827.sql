-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827215322; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- 20260827190500_trivia_atomic_session_entry.sql
-- ============================================================================
-- TIER:        3
-- AUTHOR:      Codex
-- AFFECTS:     trivia_sessions columns/index; create_trivia_session_v2 RPC
-- IRREVERSIBLE: no
--
-- WHY:
--   Paid solo modes charged in browser code before creating a session. A
--   forged request could skip the debit, while a network failure could debit
--   without producing a playable session.
--
-- HOW:
--   - Store the verified entry state on each trivia session.
--   - Debit and create the session in one server-only transaction.
--   - Link Survival levels so one paid run can continue without repeat fees.
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.trivia_sessions') IS NULL
       OR to_regclass('public.profiles') IS NULL THEN
        RAISE EXCEPTION 'pre-flight failed: trivia_sessions/profiles missing';
    END IF;
    IF to_regprocedure('public.add_diamonds_to_balance(uuid,integer,text,text,text)') IS NULL THEN
        RAISE EXCEPTION 'pre-flight failed: add_diamonds_to_balance signature missing';
    END IF;
END $$;

ALTER TABLE public.trivia_sessions
    ADD COLUMN IF NOT EXISTS parent_session_id uuid REFERENCES public.trivia_sessions(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS entry_cost int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS entry_state text NOT NULL DEFAULT 'legacy'
        CHECK (entry_state IN ('legacy', 'free', 'vip', 'charged', 'continuation'));

CREATE UNIQUE INDEX IF NOT EXISTS trivia_sessions_one_child
    ON public.trivia_sessions (parent_session_id)
    WHERE parent_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_trivia_session_v2(
    p_session_id       uuid,
    p_user_id          uuid,
    p_mode             text,
    p_question_ids     uuid[],
    p_permutations     jsonb,
    p_parent_session_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_existing public.trivia_sessions%ROWTYPE;
    v_parent   public.trivia_sessions%ROWTYPE;
    v_cost     int := CASE p_mode
        WHEN 'arcade' THEN 10 WHEN 'mtt' THEN 10 WHEN 'cash' THEN 10
        WHEN 'icm' THEN 10 WHEN 'gto' THEN 10 WHEN 'mixed' THEN 10
        WHEN 'endless' THEN 10 WHEN 'survival' THEN 10
        WHEN 'time-attack' THEN 10 ELSE 0 END;
    v_state text := 'free';
    v_charge jsonb := NULL;
    v_is_vip boolean := false;
BEGIN
    IF p_session_id IS NULL OR p_user_id IS NULL OR p_mode IS NULL
       OR COALESCE(array_length(p_question_ids, 1), 0) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_session');
    END IF;

    SELECT * INTO v_existing FROM public.trivia_sessions WHERE id = p_session_id;
    IF FOUND THEN
        IF v_existing.user_id = p_user_id AND v_existing.mode = p_mode THEN
            RETURN jsonb_build_object('success', true, 'duplicate', true,
                'entry_cost', v_existing.entry_cost, 'entry_state', v_existing.entry_state);
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'session_id_conflict');
    END IF;

    IF p_mode = 'survival' AND p_parent_session_id IS NOT NULL THEN
        SELECT * INTO v_parent
          FROM public.trivia_sessions
         WHERE id = p_parent_session_id
           FOR UPDATE;
        IF NOT FOUND OR v_parent.user_id IS DISTINCT FROM p_user_id
           OR v_parent.mode <> 'survival' OR v_parent.status <> 'submitted'
           OR v_parent.created_at < now() - interval '6 hours' THEN
            RETURN jsonb_build_object('success', false, 'error', 'invalid_survival_continuation');
        END IF;
        IF EXISTS (SELECT 1 FROM public.trivia_sessions WHERE parent_session_id = p_parent_session_id) THEN
            RETURN jsonb_build_object('success', false, 'error', 'survival_continuation_used');
        END IF;
        v_cost := 0;
        v_state := 'continuation';
    ELSIF v_cost > 0 THEN
        SELECT COALESCE(is_vip, false) INTO v_is_vip
          FROM public.profiles WHERE id = p_user_id;
        IF v_is_vip THEN
            v_cost := 0;
            v_state := 'vip';
        ELSE
            SELECT public.add_diamonds_to_balance(
                p_user_id      => p_user_id,
                p_amount       => -v_cost,
                p_type         => 'trivia_entry',
                p_description  => 'Trivia entry (' || p_mode || ')',
                p_reference_id => 'trivia_entry_' || p_session_id::text
            ) INTO v_charge;
            IF v_charge IS NULL OR COALESCE((v_charge->>'success')::boolean, false) IS NOT TRUE THEN
                RETURN jsonb_build_object('success', false, 'error', 'insufficient_diamonds');
            END IF;
            v_state := 'charged';
        END IF;
    END IF;

    INSERT INTO public.trivia_sessions (
        id, user_id, mode, question_ids, permutations, status,
        parent_session_id, entry_cost, entry_state
    ) VALUES (
        p_session_id, p_user_id, p_mode, p_question_ids,
        COALESCE(p_permutations, '{}'::jsonb), 'open',
        p_parent_session_id, v_cost, v_state
    );

    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'entry_cost', v_cost,
        'entry_state', v_state,
        'new_balance', CASE WHEN v_charge IS NULL THEN NULL ELSE v_charge->'new_balance' END
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_trivia_session_v2(uuid, uuid, text, uuid[], jsonb, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_trivia_session_v2(uuid, uuid, text, uuid[], jsonb, uuid)
    TO service_role;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'trivia_sessions'
           AND column_name IN ('parent_session_id', 'entry_cost', 'entry_state')
         GROUP BY table_schema, table_name HAVING count(*) = 3
    ) THEN
        RAISE EXCEPTION 'post-apply failed: trivia entry columns missing';
    END IF;
    IF to_regprocedure('public.create_trivia_session_v2(uuid,uuid,text,uuid[],jsonb,uuid)') IS NULL THEN
        RAISE EXCEPTION 'post-apply failed: create_trivia_session_v2 missing';
    END IF;
    IF has_function_privilege('anon', 'public.create_trivia_session_v2(uuid,uuid,text,uuid[],jsonb,uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.create_trivia_session_v2(uuid,uuid,text,uuid[],jsonb,uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'post-apply failed: browser role can create paid session';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ROLLBACK (apply as a new migration; only safe after dependent code is removed)
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.create_trivia_session_v2(uuid, uuid, text, uuid[], jsonb, uuid);
-- DROP INDEX IF EXISTS public.trivia_sessions_one_child;
-- ALTER TABLE public.trivia_sessions DROP COLUMN IF EXISTS entry_state;
-- ALTER TABLE public.trivia_sessions DROP COLUMN IF EXISTS entry_cost;
-- ALTER TABLE public.trivia_sessions DROP COLUMN IF EXISTS parent_session_id;
-- COMMIT;

