-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424021753 "20260421185000_hg_counter_bounds_check_gte_zero"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3760c51063c98ad45a0d6f3764bde6ad of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Deeper bug hunt: 6 counter columns lack CHECK >= 0. A bug in a
-- future trigger that decrements these could drive them negative
-- silently. NOT VALID omitted — zero existing negatives verified.

ALTER TABLE public.commander_home_groups
  ADD CONSTRAINT commander_home_groups_share_click_count_nonneg
    CHECK (share_click_count IS NULL OR share_click_count >= 0);

ALTER TABLE public.commander_home_groups
  ADD CONSTRAINT commander_home_groups_view_count_nonneg
    CHECK (view_count IS NULL OR view_count >= 0);

ALTER TABLE public.commander_home_posts
  ADD CONSTRAINT commander_home_posts_likes_count_nonneg
    CHECK (likes_count IS NULL OR likes_count >= 0);

ALTER TABLE public.commander_home_posts
  ADD CONSTRAINT commander_home_posts_comments_count_nonneg
    CHECK (comments_count IS NULL OR comments_count >= 0);

ALTER TABLE public.commander_home_invite_tokens
  ADD CONSTRAINT commander_home_invite_tokens_click_count_nonneg
    CHECK (click_count IS NULL OR click_count >= 0);

ALTER TABLE public.commander_home_members
  ADD CONSTRAINT commander_home_members_games_hosted_nonneg
    CHECK (games_hosted IS NULL OR games_hosted >= 0);
