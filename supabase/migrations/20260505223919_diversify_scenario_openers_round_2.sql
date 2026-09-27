-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260505223919 "diversify_scenario_openers_round_2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c03592276f921fc33a427fd40a83ecbd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

BEGIN;

-- Vary "How should you mentally approach X" → 8 alternatives
UPDATE training_question_cache
SET question_data = jsonb_set(question_data, '{question}',
    to_jsonb(
        CASE substr(md5(question_data->>'id' || ':round2a'), 1, 1)
            WHEN '0' THEN 'How can you mentally orient yourself toward '
            WHEN '1' THEN 'What is your psychological game plan for '
            WHEN '2' THEN 'How would you frame your thinking about '
            WHEN '3' THEN 'What mental angle helps you take on '
            WHEN '4' THEN 'How can you set your mindset to address '
            WHEN '5' THEN 'What is the disciplined way to think about '
            WHEN '6' THEN 'How do you mentally prepare for '
            WHEN '7' THEN 'Which mindset best equips you for '
            WHEN '8' THEN 'How would you mentally position yourself for '
            WHEN '9' THEN 'What thought process serves you in '
            WHEN 'a' THEN 'How do you bring focus to '
            WHEN 'b' THEN 'What internal posture fits '
            WHEN 'c' THEN 'How can you keep your head clear in '
            WHEN 'd' THEN 'What mental strategy applies to '
            WHEN 'e' THEN 'How do you center yourself before '
            ELSE 'How would you cognitively approach '
        END
        || REGEXP_REPLACE(question_data->>'question',
            '^How should you mentally approach ', '', 'i')
    ),
    true
)
WHERE question_data->>'type' = 'SCENARIO'
  AND question_data->>'question' ILIKE 'How should you mentally approach %';

-- Vary "How should you mentally reset X" → 6 alternatives
UPDATE training_question_cache
SET question_data = jsonb_set(question_data, '{question}',
    to_jsonb(
        CASE substr(md5(question_data->>'id' || ':round2b'), 1, 1)
            WHEN '0' THEN 'How can you reset your focus to '
            WHEN '1' THEN 'What is your reset strategy for '
            WHEN '2' THEN 'How do you clear your head and '
            WHEN '3' THEN 'What ritual helps you reset to '
            WHEN '4' THEN 'How can you regain composure to '
            WHEN '5' THEN 'What is the disciplined reset for '
            WHEN '6' THEN 'How do you settle yourself before '
            WHEN '7' THEN 'What recovery move helps you '
            WHEN '8' THEN 'How can you re-center yourself to '
            WHEN '9' THEN 'What is your bounce-back routine for '
            WHEN 'a' THEN 'How would you regroup mentally to '
            WHEN 'b' THEN 'What gets you back on track to '
            WHEN 'c' THEN 'How do you reboot your mindset to '
            WHEN 'd' THEN 'What is the right reset for '
            WHEN 'e' THEN 'How do you find your footing to '
            ELSE 'What helps you start fresh and '
        END
        || REGEXP_REPLACE(question_data->>'question',
            '^How should you mentally reset ', '', 'i')
    ),
    true
)
WHERE question_data->>'type' = 'SCENARIO'
  AND question_data->>'question' ILIKE 'How should you mentally reset %';

-- Vary "How should you mentally refocus X" → 6 alternatives
UPDATE training_question_cache
SET question_data = jsonb_set(question_data, '{question}',
    to_jsonb(
        CASE substr(md5(question_data->>'id' || ':round2c'), 1, 1)
            WHEN '0' THEN 'How can you refocus your attention to '
            WHEN '1' THEN 'What sharpens your focus when '
            WHEN '2' THEN 'How do you bring your attention back to '
            WHEN '3' THEN 'What helps you concentrate to '
            WHEN '4' THEN 'How can you direct your focus to '
            WHEN '5' THEN 'What helps you tune in and '
            WHEN '6' THEN 'How do you recapture focus to '
            WHEN '7' THEN 'What centers your focus on '
            WHEN '8' THEN 'How would you re-engage to '
            WHEN '9' THEN 'What helps you stay locked in to '
            WHEN 'a' THEN 'How can you channel your attention to '
            WHEN 'b' THEN 'What anchors your focus when '
            WHEN 'c' THEN 'How do you sharpen up to '
            WHEN 'd' THEN 'What is your focus reset for '
            WHEN 'e' THEN 'How do you snap to attention to '
            ELSE 'What gets you locked back in to '
        END
        || REGEXP_REPLACE(question_data->>'question',
            '^How should you mentally refocus ', '', 'i')
    ),
    true
)
WHERE question_data->>'type' = 'SCENARIO'
  AND question_data->>'question' ILIKE 'How should you mentally refocus %';

DO $$
DECLARE
    top_opener_pct numeric;
    distinct_3word_openers integer;
BEGIN
    SELECT MAX(c)::numeric / SUM(c)::numeric * 100 INTO top_opener_pct
    FROM (
        SELECT COUNT(*) AS c
        FROM training_question_cache
        WHERE question_data->>'type' = 'SCENARIO'
        GROUP BY split_part(question_data->>'question', ' ', 1) || ' ' ||
                 split_part(question_data->>'question', ' ', 2) || ' ' ||
                 split_part(question_data->>'question', ' ', 3) || ' ' ||
                 split_part(question_data->>'question', ' ', 4)
    ) sub;

    SELECT COUNT(DISTINCT (split_part(question_data->>'question', ' ', 1) || ' ' ||
                          split_part(question_data->>'question', ' ', 2) || ' ' ||
                          split_part(question_data->>'question', ' ', 3) || ' ' ||
                          split_part(question_data->>'question', ' ', 4)))
      INTO distinct_3word_openers
    FROM training_question_cache WHERE question_data->>'type' = 'SCENARIO';

    RAISE NOTICE 'post-round-2: top_opener_pct=%.1f%%, distinct_4word_openers=%',
        top_opener_pct, distinct_3word_openers;
END $$;

COMMIT;
