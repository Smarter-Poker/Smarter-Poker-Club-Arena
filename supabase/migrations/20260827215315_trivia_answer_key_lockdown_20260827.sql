-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827215315; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- 20260827190000_trivia_answer_key_lockdown.sql
-- ============================================================================
-- TIER:        3
-- AUTHOR:      Codex
-- AFFECTS:     trivia_questions privileges; get_unseen_questions RPC overloads
-- IRREVERSIBLE: no
--
-- WHY:
--   Browser roles could read correct_index/explanation directly, and the
--   anti-repeat RPC returned the complete trivia_questions row. That made the
--   answer key public even though gameplay now grades through server routes.
--
-- HOW:
--   - Replace table-wide SELECT with an explicit safe-column grant.
--   - Remove browser execution from every live get_unseen_questions overload.
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.trivia_questions') IS NULL THEN
        RAISE EXCEPTION 'pre-flight failed: public.trivia_questions not found';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'trivia_questions'
           AND column_name IN ('correct_index', 'explanation')
         GROUP BY table_schema, table_name HAVING count(*) = 2
    ) THEN
        RAISE EXCEPTION 'pre-flight failed: trivia answer columns not found';
    END IF;
END $$;

REVOKE SELECT ON public.trivia_questions FROM anon, authenticated;

GRANT SELECT (
    id,
    category,
    subcategory,
    difficulty,
    question,
    options,
    quality_score,
    theme,
    daily_date,
    order_index,
    engine_metadata
) ON public.trivia_questions TO anon, authenticated;

COMMENT ON COLUMN public.trivia_questions.correct_index IS
    'Server-only answer key. Client roles have no SELECT privilege.';

COMMENT ON COLUMN public.trivia_questions.explanation IS
    'Server-only because it reveals the answer. Returned only after server grading.';

-- Older anti-repeat RPCs returned trivia_questions.correct_index and
-- explanation through SETOF table signatures. Iterate over live overloads so
-- this remains safe across environments without naming a nonexistent overload.
DO $$
DECLARE
    v_signature text;
    v_count integer := 0;
BEGIN
    FOR v_signature IN
        SELECT p.oid::regprocedure::text
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_unseen_questions'
    LOOP
        v_count := v_count + 1;
        EXECUTE format(
            'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
            v_signature
        );
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
    END LOOP;
    IF v_count = 0 THEN
        RAISE EXCEPTION 'pre-flight failed: public.get_unseen_questions not found';
    END IF;
END $$;

DO $$
BEGIN
    IF has_column_privilege('anon', 'public.trivia_questions', 'correct_index', 'SELECT')
       OR has_column_privilege('authenticated', 'public.trivia_questions', 'correct_index', 'SELECT')
       OR has_column_privilege('anon', 'public.trivia_questions', 'explanation', 'SELECT')
       OR has_column_privilege('authenticated', 'public.trivia_questions', 'explanation', 'SELECT') THEN
        RAISE EXCEPTION 'post-apply failed: browser role still has answer-key SELECT';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_unseen_questions'
           AND (has_function_privilege('anon', p.oid, 'EXECUTE')
             OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) THEN
        RAISE EXCEPTION 'post-apply failed: browser role can execute get_unseen_questions';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ROLLBACK (apply as a new migration)
-- BEGIN;
-- GRANT SELECT ON public.trivia_questions TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.get_unseen_questions(uuid, text[], integer)
--     TO PUBLIC, anon, authenticated;
-- COMMIT;

