-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423235436 "20260421094000_bug19_geeves_column_rename_hash_askcount"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8f966e9ed9133eea386b6f902edf381a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-19: Geeves missed-question tracking silently swallows every call
--
-- Both functions reference three nonexistent columns:
--   function uses → actual column
--   hash          → question_hash
--   ask_count     → asked_count
--   updated_at    → last_asked
--
-- Existing `EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL;`
-- means the functions don't throw to callers — but they also don't persist
-- any data. Geeves (the AI assistant) has been unable to log "questions
-- it couldn't answer" for as long as this drift has existed. That data
-- drives the KB improvement loop; its absence is invisible until someone
-- queries the table and sees empty.
--
-- Fix: use the correct column names. Drop the undefined_column exception
-- catch once the columns resolve (undefined_table kept as a weak safety).
-- The unique index `geeves_mq_hash_idx` confirms ON CONFLICT target.

CREATE OR REPLACE FUNCTION public.geeves_increment_missed_count(
  p_hash        text,
  p_grok_answer text DEFAULT ''::text,
  p_page        text DEFAULT ''::text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  UPDATE geeves_missed_questions
     SET asked_count = asked_count + 1,
         grok_answer = COALESCE(NULLIF(p_grok_answer, ''), grok_answer),
         page        = COALESCE(NULLIF(p_page, ''), page),
         last_asked  = now()
   WHERE question_hash = p_hash;
EXCEPTION WHEN undefined_table THEN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.geeves_upsert_missed_question(
  p_question    text,
  p_hash        text,
  p_page        text DEFAULT ''::text,
  p_grok_answer text DEFAULT ''::text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  INSERT INTO geeves_missed_questions
    (question, question_hash, page, grok_answer, asked_count, first_asked, last_asked, created_at)
  VALUES (p_question, p_hash, p_page, p_grok_answer, 1, now(), now(), now())
  ON CONFLICT (question_hash) DO UPDATE
    SET asked_count = geeves_missed_questions.asked_count + 1,
        grok_answer = COALESCE(NULLIF(EXCLUDED.grok_answer, ''),
                               geeves_missed_questions.grok_answer),
        last_asked  = now();
EXCEPTION WHEN undefined_table THEN NULL;
END;
$function$;
