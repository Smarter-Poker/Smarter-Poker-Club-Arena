-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424002815 "20260424020000_hg_commercial_fk_indexes_on_hot_paths"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 256abe6c479b0d9a2fef0c7238ff0459 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Commercial-readiness: add indexes on FKs that back common read patterns.
-- Audit column FKs (hidden_by, banned_by, cancelled_by, reviewed_by,
-- checked_in_by, requested_by, added_by_user_id, reviewer_id for
-- promotions, added_by) are intentionally left unindexed — they drive
-- rare admin queries and adding indexes would only slow writes without
-- helping normal traffic.
--
-- Hot paths that need indexes:
--   • "User's poll votes"       → commander_home_poll_votes(user_id)
--   • "User's reservations"     → commander_home_seat_reservations(claimed_by_user_id)
--                              + commander_home_seat_reservations(member_id)
--   • Seat → reservation JOIN   → commander_home_seats(reservation_id)
--   • "User's uploaded photos"  → commander_home_game_photos(uploader_id)
--   • "User's reviews"          → commander_home_game_reviews(reviewer_id)
--   • "Templates I created"     → commander_home_game_templates(created_by)
--   • "Polls I created"         → commander_home_polls(created_by)
--   • "Invites I created"       → commander_home_invite_tokens(created_by)

CREATE INDEX IF NOT EXISTS idx_commander_home_poll_votes_user_id
  ON public.commander_home_poll_votes(user_id);

CREATE INDEX IF NOT EXISTS idx_commander_home_seat_reservations_claimed_by
  ON public.commander_home_seat_reservations(claimed_by_user_id)
  WHERE claimed_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commander_home_seat_reservations_member_id
  ON public.commander_home_seat_reservations(member_id)
  WHERE member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commander_home_seats_reservation_id
  ON public.commander_home_seats(reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commander_home_game_photos_uploader_id
  ON public.commander_home_game_photos(uploader_id);

CREATE INDEX IF NOT EXISTS idx_commander_home_game_reviews_reviewer_id
  ON public.commander_home_game_reviews(reviewer_id);

CREATE INDEX IF NOT EXISTS idx_commander_home_game_templates_created_by
  ON public.commander_home_game_templates(created_by);

CREATE INDEX IF NOT EXISTS idx_commander_home_polls_created_by
  ON public.commander_home_polls(created_by);

CREATE INDEX IF NOT EXISTS idx_commander_home_invite_tokens_created_by
  ON public.commander_home_invite_tokens(created_by);
