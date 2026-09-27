-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419155507 "phase24b1_schema_column_additions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 dc7a9fb81e004c8a81e08a149d3ea4ed of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART B1 — Schema column additions to existing tables
--  -----------------------------------------------------------------------
--  P3.2  commander_home_rsvps.checked_in_at        — attendance tracking
--  P3.3  commander_home_rsvps.flaked               — no-show audit
--  P3.4  commander_home_groups.tags                — category filters
--  P3.5  commander_home_groups.share_click_count   — invite conversion
--  P3.6  commander_home_groups.promoted_to_club_id — graduation link
--  P3.7  commander_home_games.cover_photo_url      — per-game hero
--  P3.8  commander_home_games.cancelled_at/by/reason — cancellation audit
--  P4.7  user_notification_preferences.home_game_* — per-user opt-ins
-- =========================================================================

-- ────────────────────────────────────────────────────────────────────────
-- P3.2 / P3.3: RSVP attendance tracking
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE commander_home_rsvps
    ADD COLUMN IF NOT EXISTS checked_in_at timestamptz,
    ADD COLUMN IF NOT EXISTS checked_in_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS flaked boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS final_result_note text;  -- optional host note post-game

COMMENT ON COLUMN commander_home_rsvps.checked_in_at IS
  'Phase 24/P3.2: timestamp when host marked this player as arrived at the game';
COMMENT ON COLUMN commander_home_rsvps.flaked IS
  'Phase 24/P3.3: true if player RSVPd yes but did not show. Used for host reputation signals.';

-- ────────────────────────────────────────────────────────────────────────
-- P3.4: group tags
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE commander_home_groups
    ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_home_groups_tags 
    ON commander_home_groups USING GIN (tags);

COMMENT ON COLUMN commander_home_groups.tags IS
  'Phase 24/P3.4: category tags for search filters. Suggested values: tournament-heavy, dealer-choice, mixed-games, beginner-friendly, high-stakes, charity, women-only, no-alcohol, plo-focused, seniors.';

-- ────────────────────────────────────────────────────────────────────────
-- P3.5: invite share tracking
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE commander_home_groups
    ADD COLUMN IF NOT EXISTS share_click_count integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS view_count integer DEFAULT 0 NOT NULL;

COMMENT ON COLUMN commander_home_groups.share_click_count IS
  'Phase 24/P3.5: incremented when someone clicks a share link. Tracks invite conversion rate.';
COMMENT ON COLUMN commander_home_groups.view_count IS
  'Phase 24/P3.5: incremented on each public detail page view. Tracks group discovery visibility.';

-- ────────────────────────────────────────────────────────────────────────
-- P3.6: club graduation path
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE commander_home_groups
    ADD COLUMN IF NOT EXISTS promoted_to_club_id uuid,  -- deliberate soft ref, clubs may not exist yet
    ADD COLUMN IF NOT EXISTS promotion_requested_at timestamptz,
    ADD COLUMN IF NOT EXISTS promotion_approved_at timestamptz;

COMMENT ON COLUMN commander_home_groups.promoted_to_club_id IS
  'Phase 24/P3.6: if a home group has graduated to a full Club, this links to the clubs.id. Soft reference (no FK) since clubs feature may lag.';

-- ────────────────────────────────────────────────────────────────────────
-- P3.7: per-game cover photo
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE commander_home_games
    ADD COLUMN IF NOT EXISTS cover_photo_url text;

COMMENT ON COLUMN commander_home_games.cover_photo_url IS
  'Phase 24/P3.7: optional hero image per game (e.g. tournament flyer).';

-- ────────────────────────────────────────────────────────────────────────
-- P3.8: game cancellation audit
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE commander_home_games
    ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
    ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS cancellation_reason text;

COMMENT ON COLUMN commander_home_games.cancelled_at IS
  'Phase 24/P3.8: set by cancel_home_game RPC. Retained for audit and RSVP archaeology.';

-- ────────────────────────────────────────────────────────────────────────
-- P4.7: user_notification_preferences for home games
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE user_notification_preferences
    ADD COLUMN IF NOT EXISTS home_game_rsvp_confirmations boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS home_game_reminders          boolean DEFAULT true,  -- 6h + 1h pings
    ADD COLUMN IF NOT EXISTS home_game_announcements      boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS home_game_host_requests      boolean DEFAULT true,  -- host receives pending-join pings
    ADD COLUMN IF NOT EXISTS home_game_new_game_posted    boolean DEFAULT true,  -- member receives new-game notices
    ADD COLUMN IF NOT EXISTS home_game_cancellations      boolean DEFAULT true,  -- all RSVPd get cancellation alert
    ADD COLUMN IF NOT EXISTS home_game_review_prompts     boolean DEFAULT false; -- default off — low-intent

COMMENT ON COLUMN user_notification_preferences.home_game_reminders IS
  'Phase 24/P4.7: controls 6h-before + 1h-before game-day reminder pings. Default on.';
