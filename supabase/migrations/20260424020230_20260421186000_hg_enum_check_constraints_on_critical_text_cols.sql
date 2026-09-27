-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424020230 "20260421186000_hg_enum_check_constraints_on_critical_text_cols"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1e7a538793b6231e24d4d8965001c48b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Bug hunt: 3 critical text columns had length caps but no enum CHECK.
-- RPCs validate the enum at write-time, but a future bypass / direct
-- service-role write could insert junk. Pin the enum at the DB layer.
--
-- Also: normalize one 'NLH' row to 'nlh' (case drift).
--
--   commander_home_rsvps.response            → {yes,maybe,no,waitlist}
--   commander_home_content_reports.action_taken → 6-value moderator action set
--   commander_home_games.address_visible_to → {all,rsvp,approved}

-- 1. Normalize case drift
UPDATE public.commander_home_game_tables
   SET game_type = lower(game_type)
 WHERE game_type <> lower(game_type);

-- 2. commander_home_rsvps.response enum CHECK
ALTER TABLE public.commander_home_rsvps
  DROP CONSTRAINT IF EXISTS commander_home_rsvps_response_check;
ALTER TABLE public.commander_home_rsvps
  ADD CONSTRAINT commander_home_rsvps_response_check
  CHECK (response IS NULL OR response IN ('yes','maybe','no','waitlist'));

-- 3. commander_home_content_reports.action_taken enum CHECK
ALTER TABLE public.commander_home_content_reports
  DROP CONSTRAINT IF EXISTS commander_home_content_reports_action_taken_check;
ALTER TABLE public.commander_home_content_reports
  ADD CONSTRAINT commander_home_content_reports_action_taken_check
  CHECK (action_taken IS NULL OR action_taken IN
    ('dismiss','hide_content','delete_content',
     'warn_author','strike_author','ban_author'));

-- 4. commander_home_games.address_visible_to enum CHECK
ALTER TABLE public.commander_home_games
  DROP CONSTRAINT IF EXISTS commander_home_games_address_visible_to_check;
ALTER TABLE public.commander_home_games
  ADD CONSTRAINT commander_home_games_address_visible_to_check
  CHECK (address_visible_to IS NULL OR address_visible_to IN ('all','rsvp','approved'));
