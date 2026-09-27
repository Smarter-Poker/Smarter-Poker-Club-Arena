-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260426013431 "20260426060000_hg_feed_filters_hidden_content_for_non_staff"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a03a8f3cb7f986edf57fb9cecb29ee0d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX: get_home_group_feed leaked hidden content.
--
-- This SECDEF function bypasses RLS and was missing is_hidden filters on:
--   - post_entries  (commander_home_posts.is_hidden exists)
--   - photo_entries (commander_home_game_photos.is_hidden exists)
--
-- The earlier RLS migrations 20260426030000 + 20260426040000 covered direct
-- table queries, but this RPC sits above RLS and would still serve hidden
-- posts to every member of the group.
--
-- Pattern matches the RLS policy: hidden content visible only to author + staff.
-- For the feed, that's:
--   - Post author sees their own hidden post (so "your post was hidden" UI works)
--   - Group staff (host + admin + co_host once supported) sees all hidden content
--   - Everyone else: hidden content excluded from feed
--
-- Polls + games don't have is_hidden so they're unchanged.

CREATE OR REPLACE FUNCTION public.get_home_group_feed(
  p_group_id uuid,
  p_caller_user_id uuid,
  p_limit integer DEFAULT 20,
  p_before timestamptz DEFAULT NULL
)
RETURNS TABLE (
  entry_type text, entry_id uuid, created_at timestamptz, author_id uuid,
  author_name text, author_avatar text, title text, content text,
  image_urls text[], metadata jsonb, link_to text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_group RECORD; v_is_member boolean; v_is_staff boolean;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role'
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    v_is_member := (v_group.owner_id = p_caller_user_id)
                OR EXISTS (SELECT 1 FROM commander_home_members
                            WHERE group_id = p_group_id AND user_id = p_caller_user_id
                              AND status = 'approved');
    IF v_group.is_private AND NOT v_is_member THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

    -- For hidden-content visibility decisions
    v_is_staff := public.fn_home_is_group_staff(p_caller_user_id, p_group_id);

    RETURN QUERY
    WITH post_entries AS (
        SELECT 'post'::text AS et, p.id, p.created_at, p.author_id,
               COALESCE(pr.display_name, pr.full_name, 'Member')::text AS aname,
               pr.avatar_url,
               NULL::text AS ttl,
               p.content,
               COALESCE(p.image_urls, ARRAY[]::text[]) AS image_urls,
               jsonb_build_object(
                   'post_type', p.post_type, 'is_pinned', p.is_pinned,
                   'likes_count', p.likes_count, 'comments_count', p.comments_count,
                   'is_hidden', COALESCE(p.is_hidden, false)
               ) AS meta,
               ('/hub/home-games/' || p_group_id::text || '#post-' || p.id::text)::text AS lnk
          FROM commander_home_posts p
          LEFT JOIN profiles pr ON pr.id = p.author_id
         WHERE p.group_id = p_group_id
           AND (p.visible_to = 'public' OR v_is_member)
           AND (
             COALESCE(p.is_hidden, false) = false           -- visible to all qualifying viewers
             OR p.author_id = p_caller_user_id              -- author always sees own
             OR v_is_staff                                  -- staff sees hidden for review
           )
    ),
    game_entries AS (
        SELECT 'game'::text AS et, g.id, g.created_at, g.host_id AS author_id,
               COALESCE(pr.display_name, pr.full_name, 'Host')::text AS aname,
               pr.avatar_url,
               COALESCE(g.title, 'Home game')::text AS ttl,
               g.description AS content,
               CASE WHEN g.cover_photo_url IS NOT NULL
                    THEN ARRAY[g.cover_photo_url]
                    ELSE ARRAY[]::text[] END AS image_urls,
               jsonb_build_object(
                   'status', g.status, 'scheduled_date', g.scheduled_date,
                   'start_time', g.start_time, 'stakes', g.stakes,
                   'game_type', g.game_type, 'format', g.format,
                   'rsvp_yes', g.rsvp_yes, 'max_players', g.max_players
               ) AS meta,
               ('/hub/home-games/' || p_group_id::text || '/games/' || g.id::text)::text AS lnk
          FROM commander_home_games g
          LEFT JOIN profiles pr ON pr.id = g.host_id
         WHERE g.group_id = p_group_id
           AND (NOT v_group.is_private OR v_is_member)
    ),
    poll_entries AS (
        SELECT 'poll'::text AS et, pl.id, pl.created_at, pl.created_by AS author_id,
               COALESCE(pr.display_name, pr.full_name, 'Member')::text AS aname,
               pr.avatar_url,
               pl.question::text AS ttl,
               NULL::text AS content,
               ARRAY[]::text[] AS image_urls,
               jsonb_build_object(
                   'poll_type', pl.poll_type, 'options', pl.options,
                   'is_closed', pl.is_closed, 'closes_at', pl.closes_at,
                   'vote_count', (SELECT COUNT(*) FROM commander_home_poll_votes
                                   WHERE poll_id = pl.id)
               ) AS meta,
               ('/hub/home-games/' || p_group_id::text || '#poll-' || pl.id::text)::text AS lnk
          FROM commander_home_polls pl
          LEFT JOIN profiles pr ON pr.id = pl.created_by
         WHERE pl.group_id = p_group_id
           AND v_is_member
    ),
    photo_entries AS (
        SELECT 'photo'::text AS et, ph.id, ph.created_at, ph.uploader_id AS author_id,
               COALESCE(pr.display_name, pr.full_name, 'Member')::text AS aname,
               pr.avatar_url,
               NULL::text AS ttl,
               ph.caption AS content,
               ARRAY[ph.photo_url] AS image_urls,
               jsonb_build_object('game_id', ph.game_id, 'is_featured', ph.is_featured) AS meta,
               ('/hub/home-games/' || p_group_id::text || '/games/' || ph.game_id::text)::text AS lnk
          FROM commander_home_game_photos ph
          LEFT JOIN profiles pr ON pr.id = ph.uploader_id
          JOIN commander_home_games g ON g.id = ph.game_id
         WHERE g.group_id = p_group_id
           AND (NOT v_group.is_private OR v_is_member)
           AND (
             COALESCE(ph.is_hidden, false) = false
             OR ph.uploader_id = p_caller_user_id
             OR v_is_staff
           )
    ),
    unified AS (
        SELECT * FROM post_entries
        UNION ALL SELECT * FROM game_entries
        UNION ALL SELECT * FROM poll_entries
        UNION ALL SELECT * FROM photo_entries
    )
    SELECT u.et, u.id, u.created_at, u.author_id, u.aname, u.avatar_url,
           u.ttl, u.content, u.image_urls, u.meta, u.lnk
      FROM unified u
     WHERE (p_before IS NULL OR u.created_at < p_before)
     ORDER BY u.created_at DESC
     LIMIT GREATEST(1, LEAST(p_limit, 100));
END;
$$;
