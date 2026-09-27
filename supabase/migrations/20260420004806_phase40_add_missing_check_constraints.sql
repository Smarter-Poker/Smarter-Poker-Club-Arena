-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420004806 "phase40_add_missing_check_constraints"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a4754c14cd5970edf47c9acee529b08d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — missing CHECK constraints on home-games numeric/text fields.
-- All production data already clean; these are preventative guards against
-- future bad INSERTs/UPDATEs. None of them should break legitimate writes.
-- ============================================================================

-- commander_home_games: numeric sanity
ALTER TABLE commander_home_games
  ADD CONSTRAINT chk_home_games_max_players
    CHECK (max_players IS NULL OR (max_players >= 1 AND max_players <= 100)),
  ADD CONSTRAINT chk_home_games_min_players
    CHECK (min_players IS NULL OR (min_players >= 0 AND min_players <= 100)),
  ADD CONSTRAINT chk_home_games_min_le_max
    CHECK (min_players IS NULL OR max_players IS NULL OR min_players <= max_players),
  ADD CONSTRAINT chk_home_games_buyin_min_nonneg
    CHECK (buyin_min IS NULL OR buyin_min >= 0),
  ADD CONSTRAINT chk_home_games_buyin_max_nonneg
    CHECK (buyin_max IS NULL OR buyin_max >= 0),
  ADD CONSTRAINT chk_home_games_buyin_min_le_max
    CHECK (buyin_min IS NULL OR buyin_max IS NULL OR buyin_min <= buyin_max),
  ADD CONSTRAINT chk_home_games_rsvp_yes_nonneg
    CHECK (rsvp_yes IS NULL OR rsvp_yes >= 0),
  ADD CONSTRAINT chk_home_games_rsvp_maybe_nonneg
    CHECK (rsvp_maybe IS NULL OR rsvp_maybe >= 0),
  ADD CONSTRAINT chk_home_games_rsvp_no_nonneg
    CHECK (rsvp_no IS NULL OR rsvp_no >= 0),
  ADD CONSTRAINT chk_home_games_waitlist_nonneg
    CHECK (waitlist_count IS NULL OR waitlist_count >= 0);

-- commander_home_groups: numeric sanity
ALTER TABLE commander_home_groups
  ADD CONSTRAINT chk_home_groups_max_players
    CHECK (max_players IS NULL OR (max_players >= 1 AND max_players <= 100)),
  ADD CONSTRAINT chk_home_groups_typical_buyin_min_nonneg
    CHECK (typical_buyin_min IS NULL OR typical_buyin_min >= 0),
  ADD CONSTRAINT chk_home_groups_typical_buyin_max_nonneg
    CHECK (typical_buyin_max IS NULL OR typical_buyin_max >= 0),
  ADD CONSTRAINT chk_home_groups_typical_buyin_min_le_max
    CHECK (typical_buyin_min IS NULL OR typical_buyin_max IS NULL
           OR typical_buyin_min <= typical_buyin_max),
  ADD CONSTRAINT chk_home_groups_member_count_nonneg
    CHECK (member_count IS NULL OR member_count >= 0),
  ADD CONSTRAINT chk_home_groups_games_hosted_nonneg
    CHECK (games_hosted IS NULL OR games_hosted >= 0);

-- commander_home_members: flake strikes
ALTER TABLE commander_home_members
  ADD CONSTRAINT chk_home_members_flake_strikes
    CHECK (flake_strikes IS NULL OR flake_strikes >= 0);

-- commander_home_rsvps: guests sanity
ALTER TABLE commander_home_rsvps
  ADD CONSTRAINT chk_home_rsvps_bringing_guests
    CHECK (bringing_guests IS NULL OR (bringing_guests >= 0 AND bringing_guests <= 20));

-- commander_home_game_reviews: text length cap (DoS prevention)
ALTER TABLE commander_home_game_reviews
  ADD CONSTRAINT chk_home_reviews_text_length
    CHECK (review_text IS NULL OR length(review_text) <= 10000);

-- commander_home_posts: content length cap (DoS prevention)
-- First check if a constraint already exists to avoid duplicate error
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_home_posts_content_length'
      AND conrelid = 'commander_home_posts'::regclass
  ) THEN
    -- Check for any existing content-length constraint
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = 'commander_home_posts'::regclass
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%length(content)%'
    ) THEN
      ALTER TABLE commander_home_posts
        ADD CONSTRAINT chk_home_posts_content_length
          CHECK (content IS NULL OR length(content) <= 10000);
    END IF;
  END IF;
END $$;
