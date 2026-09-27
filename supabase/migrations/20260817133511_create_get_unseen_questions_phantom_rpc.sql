-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260817133511 "create_get_unseen_questions_phantom_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 30d4cb9498bba2210c4080b784cbc8e9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- PHANTOM RPC: get_unseen_questions
--
-- WH src/lib/triviaQuestionLoader.js calls
--   supabase.rpc('get_unseen_questions', { p_user, p_categories, p_count })
-- as step 1 of loadQuestionsForUser(), described in its own comment as
-- "the server-side anti-join if the database exposes it". It never existed, so
-- every call has thrown PGRST202 and fallen through to the client-side
-- pipeline, which pulls a random pool of at least max(200, count*5) rows and
-- retries up to 3 times, then filters in JavaScript.
--
-- The anti-join belongs in the database: user_seen_questions is indexed on
-- user_id, and this returns exactly `p_count` rows instead of shipping several
-- hundred to the browser to be discarded.
--
-- Note the join is question_id::text -- user_seen_questions.question_id is text
-- while trivia_questions.id is uuid, because that table is shared with
-- non-trivia games keyed by game_id.
--
-- The client fallback is deliberately left in place: it also handles the
-- userId-less case and category/difficulty shaping this RPC does not cover.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_unseen_questions(
  p_user       uuid,
  p_categories text[] DEFAULT NULL,
  p_count      integer DEFAULT 20
)
RETURNS SETOF public.trivia_questions
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT q.*
    FROM public.trivia_questions q
   WHERE (p_categories IS NULL OR array_length(p_categories, 1) IS NULL OR q.category = ANY(p_categories))
     AND NOT EXISTS (
           SELECT 1
             FROM public.user_seen_questions s
            WHERE s.user_id = p_user
              AND s.question_id = q.id::text
         )
   ORDER BY random()
   LIMIT GREATEST(COALESCE(p_count, 20), 0);
$function$;

REVOKE EXECUTE ON FUNCTION public.get_unseen_questions(uuid, text[], integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_unseen_questions(uuid, text[], integer) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_user_seen_questions_user_question
  ON public.user_seen_questions (user_id, question_id);

COMMENT ON FUNCTION public.get_unseen_questions(uuid, text[], integer) IS
  'Server-side anti-join for triviaQuestionLoader.loadQuestionsForUser(). Returns up to p_count trivia_questions the user has never been shown. SECURITY INVOKER so RLS on trivia_questions still applies.';

DO $assert$
DECLARE
  v_user uuid; n_ret int; n_seen_overlap int; n_pool int;
BEGIN
  SELECT count(*) INTO n_pool FROM public.trivia_questions;
  IF n_pool = 0 THEN RAISE NOTICE 'no trivia questions - skipping assertions'; RETURN; END IF;

  -- pick the user with the most seen questions: the hardest case for an anti-join
  SELECT user_id INTO v_user
    FROM public.user_seen_questions GROUP BY user_id ORDER BY count(*) DESC LIMIT 1;

  IF v_user IS NULL THEN
    SELECT count(*) INTO n_ret FROM public.get_unseen_questions(gen_random_uuid(), NULL, 5);
    IF n_ret <> LEAST(5, n_pool) THEN
      RAISE EXCEPTION 'expected % rows for a user with no history, got %', LEAST(5, n_pool), n_ret;
    END IF;
    RETURN;
  END IF;

  SELECT count(*) INTO n_ret FROM public.get_unseen_questions(v_user, NULL, 10);

  -- nothing returned may already be in that user's seen list
  SELECT count(*) INTO n_seen_overlap
    FROM public.get_unseen_questions(v_user, NULL, 50) g
    JOIN public.user_seen_questions s
      ON s.user_id = v_user AND s.question_id = g.id::text;

  IF n_seen_overlap <> 0 THEN
    RAISE EXCEPTION 'anti-join leaked % already-seen questions', n_seen_overlap;
  END IF;

  IF has_function_privilege('anon', 'public.get_unseen_questions(uuid, text[], integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon should not be able to execute get_unseen_questions';
  END IF;

  RAISE NOTICE 'get_unseen_questions verified: % rows returned, 0 already-seen leaked (pool %)', n_ret, n_pool;
END
$assert$;

