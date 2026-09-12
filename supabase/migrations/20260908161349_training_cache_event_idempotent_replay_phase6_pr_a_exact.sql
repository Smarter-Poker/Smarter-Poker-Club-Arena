-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908161349; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908161349   (the stamp IS the apply time, UTC: 2026-09-08 16:13:49)
--   name        training_cache_event_idempotent_replay_phase6_pr_a_exact
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 8568 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908161349 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_training_cache_record_event
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- Immutable Training delivery receipts must remain replayable after the
-- mutable cache row is replaced, deactivated, or removed. A duplicate event
-- key is accepted only when the immutable ledger proves the exact original
-- question, user, verdict, and policy-checksum binding. New event keys still
-- require a currently active cache row and update its counters atomically.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.fn_training_cache_record_event(
    p_event_type text,
    p_event_key text,
    p_question_id text,
    p_user_id uuid DEFAULT NULL,
    p_is_correct boolean DEFAULT NULL,
    p_metadata jsonb DEFAULT '{}'::jsonb,
    p_occurred_at timestamptz DEFAULT now(),
    p_expected_policy_checksum text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_inserted boolean := false;
    v_rows integer := 0;
    v_occurred_at timestamptz := coalesce(p_occurred_at, now());
    v_existing public.training_question_events%ROWTYPE;
    v_cache public.training_question_cache%ROWTYPE;
BEGIN
    IF p_event_type NOT IN ('served', 'answered', 'completed') THEN
        RAISE EXCEPTION 'invalid_training_cache_event_type';
    END IF;
    IF nullif(btrim(p_event_key), '') IS NULL OR length(p_event_key) > 320 THEN
        RAISE EXCEPTION 'invalid_training_cache_event_key';
    END IF;
    IF nullif(btrim(p_question_id), '') IS NULL OR length(p_question_id) > 180 THEN
        RAISE EXCEPTION 'invalid_training_cache_question_id';
    END IF;
    IF (p_event_type = 'answered') <> (p_is_correct IS NOT NULL) THEN
        RAISE EXCEPTION 'answered_event_requires_is_correct';
    END IF;
    IF p_metadata IS NOT NULL AND jsonb_typeof(p_metadata) <> 'object' THEN
        RAISE EXCEPTION 'invalid_training_cache_event_metadata';
    END IF;

    -- Retry the immutable receipt before consulting mutable cache state. This
    -- is the recovery path: an old delivery remains idempotent even after its
    -- source cache row is no longer active. Any changed binding fails closed.
    SELECT * INTO v_existing
    FROM public.training_question_events e
    WHERE e.event_type = p_event_type
      AND e.event_key = p_event_key;
    IF FOUND THEN
        IF v_existing.question_id <> p_question_id
           OR v_existing.user_id IS DISTINCT FROM p_user_id
           OR v_existing.is_correct IS DISTINCT FROM p_is_correct
           OR (p_expected_policy_checksum IS NOT NULL
               AND v_existing.policy_checksum <> lower(p_expected_policy_checksum)) THEN
            RAISE EXCEPTION 'training_cache_event_binding_mismatch';
        END IF;
        RETURN jsonb_build_object(
            'inserted', false,
            'questionId', v_existing.question_id,
            'cacheRowFound', false,
            'policyChecksum', v_existing.policy_checksum,
            'served', 0,
            'answered', 0,
            'correct', 0,
            'completed', 0
        );
    END IF;

    -- Only a genuinely new receipt may depend on mutable cache state. The row
    -- lock serializes its event insertion with all four counter mirrors.
    SELECT * INTO v_cache
    FROM public.training_question_cache c
    WHERE c.question_id = p_question_id
      AND c.quality_status IN ('active', 'active_fallback')
    FOR UPDATE;
    IF v_cache.id IS NULL THEN
        RAISE EXCEPTION 'training_cache_event_question_not_active';
    END IF;
    IF p_expected_policy_checksum IS NOT NULL
       AND lower(p_expected_policy_checksum) <> v_cache.policy_checksum THEN
        RAISE EXCEPTION 'training_cache_event_stale_policy';
    END IF;

    INSERT INTO public.training_question_events (
        event_type, event_key, question_id, user_id, is_correct, policy_checksum,
        metadata, occurred_at
    ) VALUES (
        p_event_type, p_event_key, p_question_id, p_user_id, p_is_correct,
        v_cache.policy_checksum, coalesce(p_metadata, '{}'::jsonb), v_occurred_at
    )
    ON CONFLICT (event_type, event_key) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_inserted := v_rows = 1;

    IF NOT v_inserted THEN
        -- A concurrent request may have won after the first read. Re-read and
        -- enforce the same immutable binding before returning idempotently.
        SELECT * INTO v_existing
        FROM public.training_question_events e
        WHERE e.event_type = p_event_type AND e.event_key = p_event_key;
        IF v_existing.id IS NULL
           OR v_existing.question_id <> p_question_id
           OR v_existing.user_id IS DISTINCT FROM p_user_id
           OR v_existing.is_correct IS DISTINCT FROM p_is_correct
           OR (p_expected_policy_checksum IS NOT NULL
               AND v_existing.policy_checksum <> lower(p_expected_policy_checksum)) THEN
            RAISE EXCEPTION 'training_cache_event_binding_mismatch';
        END IF;
    ELSE
        UPDATE public.training_question_cache c
        SET served_count = coalesce(c.served_count, 0)
                + CASE WHEN p_event_type = 'served' THEN 1 ELSE 0 END,
            answered_count = coalesce(c.answered_count, 0)
                + CASE WHEN p_event_type = 'answered' THEN 1 ELSE 0 END,
            correct_count = coalesce(c.correct_count, 0)
                + CASE WHEN p_event_type = 'answered' AND p_is_correct THEN 1 ELSE 0 END,
            completed_count = coalesce(c.completed_count, 0)
                + CASE WHEN p_event_type = 'completed' THEN 1 ELSE 0 END,
            times_used = LEAST(
                2147483647,
                coalesce(c.times_used, 0)
                    + CASE WHEN p_event_type = 'served' THEN 1 ELSE 0 END
            ),
            last_served_at = CASE WHEN p_event_type = 'served'
                THEN greatest(coalesce(c.last_served_at, '-infinity'::timestamptz), v_occurred_at)
                ELSE c.last_served_at END,
            last_answered_at = CASE WHEN p_event_type = 'answered'
                THEN greatest(coalesce(c.last_answered_at, '-infinity'::timestamptz), v_occurred_at)
                ELSE c.last_answered_at END,
            last_completed_at = CASE WHEN p_event_type = 'completed'
                THEN greatest(coalesce(c.last_completed_at, '-infinity'::timestamptz), v_occurred_at)
                ELSE c.last_completed_at END
        WHERE c.question_id = p_question_id
        RETURNING c.* INTO v_cache;
    END IF;

    RETURN jsonb_build_object(
        'inserted', v_inserted,
        'questionId', p_question_id,
        'cacheRowFound', v_cache.id IS NOT NULL,
        'policyChecksum', coalesce(v_existing.policy_checksum, v_cache.policy_checksum),
        'served', coalesce(v_cache.served_count, 0),
        'answered', coalesce(v_cache.answered_count, 0),
        'correct', coalesce(v_cache.correct_count, 0),
        'completed', coalesce(v_cache.completed_count, 0)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_training_cache_record_event(
    text, text, text, uuid, boolean, jsonb, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_training_cache_record_event(
    text, text, text, uuid, boolean, jsonb, timestamptz, text
) TO service_role;

DO $$
DECLARE
    definition text;
BEGIN
    SELECT pg_get_functiondef(
        'public.fn_training_cache_record_event(text,text,text,uuid,boolean,jsonb,timestamptz,text)'::regprocedure
    ) INTO definition;
    IF position('Retry the immutable receipt before consulting mutable cache state' IN definition) = 0
       OR position('IF FOUND THEN' IN definition) = 0
       OR position('training_cache_event_binding_mismatch' IN definition) = 0
       OR NOT (
           SELECT p.prosecdef
           FROM pg_proc p
           WHERE p.oid = 'public.fn_training_cache_record_event(text,text,text,uuid,boolean,jsonb,timestamptz,text)'::regprocedure
       )
       OR has_function_privilege(
           'anon',
           'public.fn_training_cache_record_event(text,text,text,uuid,boolean,jsonb,timestamptz,text)',
           'EXECUTE'
       )
       OR has_function_privilege(
           'authenticated',
           'public.fn_training_cache_record_event(text,text,text,uuid,boolean,jsonb,timestamptz,text)',
           'EXECUTE'
       )
       OR NOT has_function_privilege(
           'service_role',
           'public.fn_training_cache_record_event(text,text,text,uuid,boolean,jsonb,timestamptz,text)',
           'EXECUTE'
       ) THEN
        RAISE EXCEPTION 'TRAINING_CACHE_EVENT_REPLAY_CONTRACT_INCOMPLETE';
    END IF;
END;
$$;

COMMIT;
