-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506112039 "enrich_terse_chart_question_text"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 600bc42d5ea6e1989e62cde487176ec8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 56: enrich the 250 CHART rows whose question text is just
-- "Push or Fold?" by composing context-rich text from scenario fields.
-- Format matches the longer-format rows: "<pos> with <hand> at <stack>BB. <villain_action>. Push or Fold?"
BEGIN;

UPDATE training_question_cache
SET question_data = jsonb_set(
  question_data,
  '{question}',
  to_jsonb(
    COALESCE(question_data->'scenario'->>'heroPosition', 'Hero') ||
    ' with ' || COALESCE(question_data->'scenario'->>'heroHand', '?') ||
    ' at ' || COALESCE(question_data->'scenario'->>'stackDepth', '?') || 'BB. ' ||
    COALESCE(NULLIF(question_data->'scenario'->>'action', ''), 'Folded to you') || '. ' ||
    'Push or Fold?'
  ),
  true
)
WHERE question_data->>'type' = 'CHART'
  AND LENGTH(question_data->>'question') < 20;

COMMIT;
