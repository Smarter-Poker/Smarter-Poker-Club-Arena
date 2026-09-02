-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827231245; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The first v2 refill normalized solver frequencies correctly, but its option
-- permutation used the low bits of a linear congruential generator. Production
-- distribution verification caught 1,252/1,257 correct answers in slot D.
-- Retire the entire batch; v3 uses Mulberry32 and distinct provenance tags.
BEGIN;

UPDATE public.trivia_questions
   SET quality_score = 3,
       daily_date = NULL,
       engine_metadata = COALESCE(engine_metadata, '{}'::jsonb)
           || jsonb_build_object('retired_reason', 'deterministic_v2_answer_position_bias',
                                 'retired_at', now())
 WHERE source = 'deterministic'
   AND COALESCE((engine_metadata->>'engine_version')::integer, 0) = 2;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.trivia_questions
         WHERE quality_score >= 6 AND source = 'deterministic'
           AND COALESCE((engine_metadata->>'engine_version')::integer, 0) = 2
    ) THEN
        RAISE EXCEPTION 'post-apply failed: biased deterministic v2 row remains servable';
    END IF;
END $$;

COMMIT;

