-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417165648 "phase18_fixup_self_bump_trigger_excludes_admin_toggles"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 16c33e1d57ea8c397af52d77d6f8338e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  PHASE 18 FIXUP: self-bump trigger should only fire on host content edits,
--  NOT on admin toggle columns.
--
--  Admin toggles (is_active, is_private, requires_approval,
--  visibility_override_until, settings) should NOT bump last_activity_at.
--  If an admin pays for visibility_override_until, that's not "host is
--  engaged" — it's the opposite, they're buying visibility precisely
--  because they can't be engaged. Same for is_active / is_private / etc.
--
--  Only COUNT host-facing content changes:
--    profile/identity: name, description, tagline, profile_photo_url, cover_photo_url
--    game spec: default_game_type, default_stakes, typical_buyin_min/max, max_players
--    schedule: typical_day, typical_time, frequency
--    location: city, state, zip_code, latitude, longitude
--    codes: invite_code, club_code
-- ══════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_home_group_self_activity ON commander_home_groups;

CREATE TRIGGER trg_home_group_self_activity
BEFORE UPDATE ON commander_home_groups
FOR EACH ROW
WHEN (
  (OLD.name, OLD.description, OLD.profile_photo_url, OLD.cover_photo_url,
   OLD.tagline, OLD.typical_day, OLD.typical_time, OLD.default_game_type,
   OLD.default_stakes, OLD.typical_buyin_min, OLD.typical_buyin_max,
   OLD.max_players, OLD.city, OLD.state, OLD.zip_code, OLD.latitude,
   OLD.longitude, OLD.frequency, OLD.invite_code, OLD.club_code)
  IS DISTINCT FROM
  (NEW.name, NEW.description, NEW.profile_photo_url, NEW.cover_photo_url,
   NEW.tagline, NEW.typical_day, NEW.typical_time, NEW.default_game_type,
   NEW.default_stakes, NEW.typical_buyin_min, NEW.typical_buyin_max,
   NEW.max_players, NEW.city, NEW.state, NEW.zip_code, NEW.latitude,
   NEW.longitude, NEW.frequency, NEW.invite_code, NEW.club_code)
)
EXECUTE FUNCTION fn_home_group_self_activity_bump();

-- Restore Saturday Night Poker Club to its real state (test data cleanup)
UPDATE commander_home_groups
   SET last_activity_at       = NOW(),
       created_at              = '2026-02-16 14:45:59.586667+00',
       visibility_override_until = NULL
 WHERE id = '1794b3be-8313-4e82-93da-1b33f7fca801';
