-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424015740 "20260421184000_hg_trending_mv_exclude_private_groups_privacy_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 07ed9c26bd133c4d469bc29bac9d3418 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PRIVACY BUG: mv_home_groups_trending included private groups in its
-- snapshot. Anon could read trending and see:
--   - name, city, state, profile_photo_url, tags of private groups
--   - member_count, games_hosted, recent_rsvps_30d counts
-- Private groups by definition are not discoverable — they must be
-- excluded from trending entirely, not just score-penalized.
--
-- Fix: drop-recreate MV with is_private=false filter.

DROP MATERIALIZED VIEW IF EXISTS public.mv_home_groups_trending CASCADE;

CREATE MATERIALIZED VIEW public.mv_home_groups_trending AS
SELECT
  g.id AS group_id,
  g.name,
  g.city,
  g.state,
  g.is_private,   -- always false here; kept for consumer compatibility
  g.profile_photo_url,
  g.tags,
  g.location_geog,
  COALESCE(g.member_count, 0) AS member_count,
  COALESCE(g.games_hosted, 0) AS games_hosted,
  COALESCE(g.view_count, 0) AS view_count,
  COALESCE(g.share_click_count, 0) AS share_click_count,
  COALESCE((
    SELECT COUNT(*) FROM commander_home_rsvps r
      JOIN commander_home_games hg ON hg.id = r.game_id
     WHERE hg.group_id = g.id
       AND r.response = 'yes'
       AND r.responded_at > NOW() - INTERVAL '30 days'
  ), 0) AS recent_rsvps_30d,
  -- Trending score (no more private-group bonus term — all entries are public)
  (COALESCE((
    SELECT COUNT(*) FROM commander_home_rsvps r
      JOIN commander_home_games hg ON hg.id = r.game_id
     WHERE hg.group_id = g.id
       AND r.response = 'yes'
       AND r.responded_at > NOW() - INTERVAL '30 days'
  ), 0) * 10)::numeric
    + (COALESCE(g.view_count, 0))::numeric * 0.1
    + (COALESCE(g.share_click_count, 0) * 2)::numeric
    + (COALESCE(g.member_count, 0))::numeric * 0.5
  AS trending_score,
  g.last_activity_at
FROM commander_home_groups g
WHERE g.is_active = true
  AND g.is_private = false                    -- ★ CRITICAL: exclude private
  AND g.profile_photo_url IS NOT NULL
  AND g.last_activity_at > NOW() - INTERVAL '45 days'
ORDER BY trending_score DESC;

-- Index for fast ORDER BY / join
CREATE UNIQUE INDEX idx_mv_home_groups_trending_group_id
  ON public.mv_home_groups_trending (group_id);
CREATE INDEX idx_mv_home_groups_trending_score
  ON public.mv_home_groups_trending (trending_score DESC);

-- Grants: anon can still read (public groups are public) + authenticated
GRANT SELECT ON public.mv_home_groups_trending TO anon, authenticated;

COMMENT ON MATERIALIZED VIEW public.mv_home_groups_trending IS
  'Public home groups ranked by recent activity. is_private groups NEVER appear here — enforced by WHERE clause. Refreshed by home-trending-refresh cron every 15 min.';
