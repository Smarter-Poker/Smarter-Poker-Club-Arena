-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417162523 "phase18_home_group_activity_tracking"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3dd022c711e1e308949f4f746eba4e59 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  PHASE 18: Home-group activity tracking + auto-hide of orphaned groups
-- ══════════════════════════════════════════════════════════════════════
--
--  Problem: orphaned home-group accounts that were created, went silent,
--  and now pollute Poker Near Me / Home Games Near Me search results.
--
--  Solution: track `last_activity_at` on each group. Silent >= 30 days =
--  hidden from public discovery (NOT deactivated — the host can still
--  see their own group, post, and reappear instantly).
--
--  Activity signals (any one resets the 30-day clock):
--    1. New or updated commander_home_games row (host scheduled a game)
--    2. New commander_home_members row (someone joined)
--    3. New commander_home_posts row (host posted an update)
--    4. User-meaningful edit to commander_home_groups itself
--       (name, description, photo, location, stakes, schedule, etc.)
--
--  A FUTURE scheduled game also saves a group from being hidden — this
--  is enforced at the API-filter layer, not here. See cron + discover
--  endpoints.
--
--  Two notification flags:
--    inactivity_warning_sent_at  — day-21 "heads-up, will hide soon" push
--    inactivity_hidden_sent_at   — day-30+ "you are now hidden, post to
--                                  reappear" push
--  Both reset to NULL whenever activity fires → subsequent silence
--  periods notify again.
--
--  INTENTIONAL SCOPE
--    - No DB-level is_active flip (non-destructive; host dashboard still
--      shows their group normally).
--    - Applies ONLY to commander_home_groups. Clubs/charities have
--      different rhythms and separate visibility models.
--    - Private groups (is_private=true) ignored by the filter since
--      they're already hidden from public discovery.
-- ══════════════════════════════════════════════════════════════════════


-- ── COLUMNS ──────────────────────────────────────────────────────────

ALTER TABLE commander_home_groups
    ADD COLUMN IF NOT EXISTS last_activity_at          timestamptz NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS inactivity_warning_sent_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS inactivity_hidden_sent_at  timestamptz NULL;

-- Partial index to make the cron's "who's at day 21+" + "who's at day 30+"
-- scans cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_home_groups_public_activity
    ON commander_home_groups (last_activity_at)
    WHERE is_private = false AND is_active = true;


-- ── HELPER: bump last_activity_at + reset notification flags ─────────

CREATE OR REPLACE FUNCTION fn_bump_home_group_activity(p_group_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $fn$
BEGIN
  IF p_group_id IS NULL THEN RETURN; END IF;
  UPDATE commander_home_groups
     SET last_activity_at            = NOW(),
         inactivity_warning_sent_at  = NULL,
         inactivity_hidden_sent_at   = NULL
   WHERE id = p_group_id
     -- Only bump if something actually changed, to keep the self-UPDATE
     -- trigger from firing no-op UPDATEs.
     AND (   last_activity_at           < NOW() - INTERVAL '1 second'
          OR inactivity_warning_sent_at IS NOT NULL
          OR inactivity_hidden_sent_at  IS NOT NULL);
END
$fn$;


-- ── TRIGGER 1: commander_home_games (schedule/edit) ──────────────────

CREATE OR REPLACE FUNCTION trg_fn_home_game_bump_activity()
  RETURNS trigger
  LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM fn_bump_home_group_activity(NEW.group_id);
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_bump_activity_on_home_game ON commander_home_games;
CREATE TRIGGER trg_bump_activity_on_home_game
    AFTER INSERT OR UPDATE ON commander_home_games
    FOR EACH ROW EXECUTE FUNCTION trg_fn_home_game_bump_activity();


-- ── TRIGGER 2: commander_home_members (new member joins) ─────────────

CREATE OR REPLACE FUNCTION trg_fn_home_member_bump_activity()
  RETURNS trigger
  LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM fn_bump_home_group_activity(NEW.group_id);
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_bump_activity_on_home_member ON commander_home_members;
CREATE TRIGGER trg_bump_activity_on_home_member
    AFTER INSERT ON commander_home_members
    FOR EACH ROW EXECUTE FUNCTION trg_fn_home_member_bump_activity();


-- ── TRIGGER 3: commander_home_posts (host posts update) ──────────────

CREATE OR REPLACE FUNCTION trg_fn_home_post_bump_activity()
  RETURNS trigger
  LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM fn_bump_home_group_activity(NEW.group_id);
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_bump_activity_on_home_post ON commander_home_posts;
CREATE TRIGGER trg_bump_activity_on_home_post
    AFTER INSERT ON commander_home_posts
    FOR EACH ROW EXECUTE FUNCTION trg_fn_home_post_bump_activity();


-- ── TRIGGER 4: commander_home_groups SELF-update ─────────────────────
--
-- Fires BEFORE UPDATE so we can mutate NEW in-place without recursion.
-- Only sets last_activity_at if a USER-MEANINGFUL column changed; pure
-- internal flips (the activity columns themselves) are skipped.

CREATE OR REPLACE FUNCTION trg_fn_home_group_self_bump_activity()
  RETURNS trigger
  LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (OLD.name                IS DISTINCT FROM NEW.name
   OR OLD.description         IS DISTINCT FROM NEW.description
   OR OLD.profile_photo_url   IS DISTINCT FROM NEW.profile_photo_url
   OR OLD.cover_photo_url     IS DISTINCT FROM NEW.cover_photo_url
   OR OLD.tagline             IS DISTINCT FROM NEW.tagline
   OR OLD.city                IS DISTINCT FROM NEW.city
   OR OLD.state               IS DISTINCT FROM NEW.state
   OR OLD.zip_code            IS DISTINCT FROM NEW.zip_code
   OR OLD.latitude            IS DISTINCT FROM NEW.latitude
   OR OLD.longitude           IS DISTINCT FROM NEW.longitude
   OR OLD.default_game_type   IS DISTINCT FROM NEW.default_game_type
   OR OLD.default_stakes      IS DISTINCT FROM NEW.default_stakes
   OR OLD.typical_buyin_min   IS DISTINCT FROM NEW.typical_buyin_min
   OR OLD.typical_buyin_max   IS DISTINCT FROM NEW.typical_buyin_max
   OR OLD.max_players         IS DISTINCT FROM NEW.max_players
   OR OLD.typical_day         IS DISTINCT FROM NEW.typical_day
   OR OLD.typical_time        IS DISTINCT FROM NEW.typical_time
   OR OLD.frequency           IS DISTINCT FROM NEW.frequency
   OR OLD.is_private          IS DISTINCT FROM NEW.is_private
   OR OLD.is_active           IS DISTINCT FROM NEW.is_active
   OR OLD.requires_approval   IS DISTINCT FROM NEW.requires_approval
  ) THEN
    NEW.last_activity_at           := NOW();
    NEW.inactivity_warning_sent_at := NULL;
    NEW.inactivity_hidden_sent_at  := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_home_group_self_bump ON commander_home_groups;
CREATE TRIGGER trg_home_group_self_bump
    BEFORE UPDATE ON commander_home_groups
    FOR EACH ROW EXECUTE FUNCTION trg_fn_home_group_self_bump_activity();


-- ── BACKFILL last_activity_at for existing rows ──────────────────────
--
-- Use the MAX timestamp across signal tables for each group. Fall back
-- to the group's own created_at if nothing signals activity yet.

UPDATE commander_home_groups g
   SET last_activity_at = GREATEST(
       g.created_at,
       COALESCE((SELECT MAX(GREATEST(hg.created_at, hg.updated_at))
                   FROM commander_home_games hg WHERE hg.group_id = g.id), g.created_at),
       COALESCE((SELECT MAX(hm.created_at)
                   FROM commander_home_members hm WHERE hm.group_id = g.id), g.created_at),
       COALESCE((SELECT MAX(hp.created_at)
                   FROM commander_home_posts hp WHERE hp.group_id = g.id), g.created_at)
   );


COMMENT ON COLUMN commander_home_groups.last_activity_at IS
  'Phase 18: updated by triggers whenever the host or group shows signs of life. '
  'Public discovery filters out groups silent > 30 days (with future-scheduled-game override).';

COMMENT ON COLUMN commander_home_groups.inactivity_warning_sent_at IS
  'Phase 18: timestamp of the day-21 "your group will be hidden" push. '
  'Reset to NULL on any activity.';

COMMENT ON COLUMN commander_home_groups.inactivity_hidden_sent_at IS
  'Phase 18: timestamp of the day-30 "your group is now hidden, post to reappear" push. '
  'Reset to NULL on any activity.';
