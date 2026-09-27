-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260808232835 "training_challenge_icons_no_emoji"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 094c91f16b8d9e8306582a91bde8bae3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Code Safety Rule 7: no emoji in user-facing strings. The repo-wide sweep
-- (2026-07-28) removed every emoji from source; these 11 live rows in
-- training_challenge_definitions still carried emoji icons that render
-- directly in the challenges UI. Remap to the sweep's approved monochrome
-- vocabulary (target/diamond -> filled diamond, fire -> up-triangle,
-- trophy/star/crown -> star, cards -> spade, calendar -> filled square).
-- Data-only migration; no schema change.

DO $$
BEGIN
  UPDATE training_challenge_definitions SET icon = CASE id
    WHEN 'monthly_accuracy_85'   THEN '◆'
    WHEN 'monthly_all_categories' THEN '★'
    WHEN 'monthly_perfect_10'    THEN '★'
    WHEN 'monthly_sessions_30'   THEN '■'
    WHEN 'monthly_streak_14'     THEN '▲'
    WHEN 'weekly_accuracy_80'    THEN '◆'
    WHEN 'weekly_perfect_3'      THEN '◆'
    WHEN 'weekly_postflop_5'     THEN '▲'
    WHEN 'weekly_preflop_5'      THEN '♠'
    WHEN 'weekly_sessions_10'    THEN '★'
    WHEN 'weekly_sessions_5'     THEN '●'
    ELSE icon END
  WHERE id IN ('monthly_accuracy_85','monthly_all_categories','monthly_perfect_10',
               'monthly_sessions_30','monthly_streak_14','weekly_accuracy_80',
               'weekly_perfect_3','weekly_postflop_5','weekly_preflop_5',
               'weekly_sessions_10','weekly_sessions_5');

  -- Assert: no emoji-range codepoints remain in any icon.
  IF EXISTS (
    SELECT 1 FROM training_challenge_definitions
    WHERE icon ~ '[\U0001F000-\U0001FAFF☀-➿️]'
      AND icon !~ '^[♠♥♦♣★☆✓✕▲▼●○◆◇■□]$'
  ) THEN
    RAISE EXCEPTION 'emoji icons remain in training_challenge_definitions';
  END IF;
END $$;
