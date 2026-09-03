-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827225928; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Trivia phase 6: close answer-key side channels and quarantine content that
-- the production audit proved is ambiguous, duplicated, or impossible.
BEGIN;

-- The prior ALL policy was named for service role but had USING (true) and no
-- TO clause. Combined with old column-level grants it authorized browser
-- mutation. Scope the policy to the role it names and remove every browser
-- write/reference grant, including inherited column grants.
DROP POLICY IF EXISTS "Service role can manage trivia questions" ON public.trivia_questions;
CREATE POLICY "Service role can manage trivia questions"
    ON public.trivia_questions FOR ALL TO service_role
    USING (true) WITH CHECK (true);

REVOKE ALL PRIVILEGES ON public.trivia_questions FROM anon, authenticated;
DO $$
DECLARE c record;
BEGIN
    FOR c IN
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'trivia_questions'
    LOOP
        EXECUTE format(
            'REVOKE INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON public.trivia_questions FROM anon, authenticated',
            c.column_name
        );
    END LOOP;
END $$;

-- engine_metadata is deliberately absent: generator/audit metadata has held
-- original answers, stored indexes, cold-answer decisions and solver action
-- frequencies. It is returned only after a session answer is bound.
GRANT SELECT (
    id, category, subcategory, difficulty, question, options, quality_score,
    theme, daily_date, order_index
) ON public.trivia_questions TO anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_trivia_grade_answer(uuid, integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trivia_grade_answer(uuid, integer)
    TO service_role;

-- Remove the redundant explicit answer copy written by the active generator.
-- Audit evidence remains server-only and is retained for operations.
UPDATE public.trivia_questions
   SET engine_metadata = engine_metadata - 'original_correct_answer'
 WHERE engine_metadata ? 'original_correct_answer';

-- Every legacy deterministic row in production was generated on 2026-05-05
-- with the ambiguous pre-fix wording that omitted position, opponent, stack
-- and pot. Retire it; the repaired v2 generator now emits those fields.
UPDATE public.trivia_questions
   SET quality_score = 3,
       daily_date = NULL,
       engine_metadata = COALESCE(engine_metadata, '{}'::jsonb)
           || jsonb_build_object('retired_reason', 'deterministic_context_missing',
                                 'retired_at', now())
 WHERE quality_score >= 6
   AND (source = 'deterministic' OR subcategory LIKE 'det:%')
   AND question NOT ILIKE '%BB effective%';

-- Keep exactly one servable copy of every exact normalized prompt. Prefer a
-- currently tagged daily row, an audited row, then the best/newest source.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY regexp_replace(lower(trim(question)), '[^a-z0-9]+', ' ', 'g')
               ORDER BY (daily_date IS NOT NULL) DESC,
                        audit_verified DESC NULLS LAST,
                        quality_score DESC,
                        created_at DESC,
                        id
           ) AS rn
      FROM public.trivia_questions
     WHERE quality_score >= 6
), retired AS (
    SELECT id FROM ranked WHERE rn > 1
)
UPDATE public.trivia_questions q
   SET quality_score = 3,
       daily_date = NULL,
       engine_metadata = COALESCE(q.engine_metadata, '{}'::jsonb)
           || jsonb_build_object('retired_reason', 'exact_duplicate',
                                 'retired_at', now())
  FROM retired r
 WHERE q.id = r.id;

-- Quarantine the confirmed impossible As Js / Js flop row without depending
-- on an environment-specific generated UUID.
UPDATE public.trivia_questions
   SET quality_score = 3,
       daily_date = NULL,
       engine_metadata = COALESCE(engine_metadata, '{}'::jsonb)
           || jsonb_build_object('retired_reason', 'duplicate_dealt_card',
                                 'retired_at', now())
 WHERE quality_score >= 6
   AND question ILIKE '%Hero holds As Js%Flop is Js 7d 4c%';

-- Quarantine a confirmed impossible action sequence: the CO cannot call a BTN
-- open because the BTN acts after the CO preflop.
UPDATE public.trivia_questions
   SET quality_score = 3,
       daily_date = NULL,
       engine_metadata = COALESCE(engine_metadata, '{}'::jsonb)
           || jsonb_build_object('retired_reason', 'impossible_action_order',
                                 'retired_at', now())
 WHERE quality_score >= 6
   AND question ILIKE '%Hero holds AQo in CO%BTN opens%hero calls%';

-- Two manually seeded rows have internally contradictory arithmetic. The
-- ante explanation says nine big blinds under a one-big-blind-ante format;
-- the river call explanation computes 18.75% while marking 23% correct.
UPDATE public.trivia_questions
   SET quality_score = 3,
       daily_date = NULL,
       engine_metadata = COALESCE(engine_metadata, '{}'::jsonb)
           || jsonb_build_object('retired_reason', 'contradictory_math',
                                 'retired_at', now())
 WHERE quality_score >= 6
   AND (
       question ILIKE '%what percentage of the pot do the antes represent%'
       OR question ILIKE '%face a $30 river bet into a $100 pot%what pot odds%'
   );

-- Persist a stable exact-text fingerprint and prevent concurrent producers
-- from inserting two servable copies after the check-before-insert race.
ALTER TABLE public.trivia_questions
    ADD COLUMN IF NOT EXISTS question_fingerprint text
    GENERATED ALWAYS AS (
        md5(regexp_replace(lower(trim(question)), '[^a-z0-9]+', ' ', 'g'))
    ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS trivia_questions_servable_fingerprint_uidx
    ON public.trivia_questions (question_fingerprint)
    WHERE quality_score >= 6;

-- Unverified legacy rows cannot participate in public leaderboards, stats or
-- achievements. Service-role settlement remains covered by its own policy.
DROP POLICY IF EXISTS "Trivia scores are viewable by all" ON public.trivia_scores;
CREATE POLICY "Verified trivia scores are viewable by all"
    ON public.trivia_scores FOR SELECT
    USING (server_verified IS TRUE);

DO $$
BEGIN
    IF has_column_privilege('anon', 'public.trivia_questions', 'engine_metadata', 'SELECT')
       OR has_column_privilege('authenticated', 'public.trivia_questions', 'engine_metadata', 'SELECT')
       OR has_column_privilege('anon', 'public.trivia_questions', 'correct_index', 'SELECT')
       OR has_column_privilege('authenticated', 'public.trivia_questions', 'correct_index', 'SELECT') THEN
        RAISE EXCEPTION 'post-apply failed: browser still has answer-bearing columns';
    END IF;
    IF has_function_privilege('authenticated',
        'public.fn_trivia_grade_answer(uuid,integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'post-apply failed: legacy grade oracle still executable';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;

