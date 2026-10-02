-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506112116 "normalize_chart_action_string_to_human_readable"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d38d938b42fd68e1041774bbbdaa4b1d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 56b: replace raw action code "fold_to_hero" with the
-- human-readable "Folded to you" everywhere it appears in CHART rows
-- (both the scenario.action field and the question text).
BEGIN;

-- Update scenario.action field
UPDATE training_question_cache
SET question_data = jsonb_set(question_data, '{scenario,action}', '"Folded to you"', true)
WHERE question_data->>'type' = 'CHART'
  AND question_data->'scenario'->>'action' = 'fold_to_hero';

-- Replace 'fold_to_hero' substring in question text with 'Folded to you'
UPDATE training_question_cache
SET question_data = jsonb_set(
  question_data, '{question}',
  to_jsonb(REPLACE(question_data->>'question', 'fold_to_hero', 'Folded to you')),
  true
)
WHERE question_data->>'type' = 'CHART'
  AND question_data->>'question' LIKE '%fold_to_hero%';

COMMIT;
