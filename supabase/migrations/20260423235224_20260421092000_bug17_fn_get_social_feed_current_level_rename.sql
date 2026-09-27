-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423235224 "20260421092000_bug17_fn_get_social_feed_current_level_rename"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d62a92b16710873d61b13e6f05718aeb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-17: fn_get_social_feed references profiles.current_level which
-- doesn't exist. The actual column is profiles.level (integer). Same
-- class of column-rename drift as BUG-15 / BUG-16.
--
-- Impact: social feed RPC 500s on every call. High-traffic endpoint —
-- anyone who lands on the social feed gets an empty list (client
-- silently handles the error). This is the reason the social feed may
-- have looked empty in tests.
--
-- Fix: p.current_level → p.level.

CREATE OR REPLACE FUNCTION public.fn_get_social_feed(
  p_user_id uuid    DEFAULT NULL::uuid,
  p_limit   integer DEFAULT 20,
  p_offset  integer DEFAULT 0,
  p_filter  text    DEFAULT 'recent'::text
)
 RETURNS TABLE(
   post_id uuid, author_id uuid, author_username text, author_avatar text,
   author_level integer, content text, content_type text, media_urls text[],
   like_count integer, comment_count integer, share_count integer,
   is_liked boolean, created_at timestamptz
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        sp.id AS post_id,
        sp.author_id,
        COALESCE(p.username, 'Anonymous')::text AS author_username,
        p.avatar_url::text AS author_avatar,
        COALESCE(p.level, 1)::int AS author_level,          -- was p.current_level
        sp.content,
        COALESCE(sp.content_type, 'text')::text AS content_type,
        sp.media_urls,
        COALESCE(sp.like_count, 0)::int AS like_count,
        COALESCE(sp.comment_count, 0)::int AS comment_count,
        COALESCE(sp.share_count, 0)::int AS share_count,
        CASE
            WHEN p_user_id IS NOT NULL THEN
                EXISTS(
                    SELECT 1 FROM social_interactions si
                     WHERE si.post_id = sp.id
                       AND si.user_id = p_user_id
                       AND si.interaction_type = 'like'
                )
            ELSE FALSE
        END AS is_liked,
        sp.created_at
    FROM social_posts sp
    LEFT JOIN profiles p ON p.id = sp.author_id
    WHERE (sp.visibility = 'public' OR sp.visibility IS NULL)
    ORDER BY sp.created_at DESC
    LIMIT p_limit OFFSET p_offset;
END;
$function$;
