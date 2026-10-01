-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423235704 "20260421096000_bug17b_fn_get_social_feed_media_urls_jsonb_to_textarray"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 80ae184f65242079db850324447e819a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-17b: fn_get_social_feed return column 8 (media_urls) is declared
-- text[] in the RETURNS TABLE, but social_posts.media_urls is jsonb.
-- Returning sp.media_urls directly raises 42804 on every call.
--
-- Fix: cast jsonb → text[] in the SELECT. Defensive CASE handles non-
-- array jsonb (should be rare) + NULL by returning an empty array.
-- API contract preserved: callers still get media_urls as an array of
-- strings.

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
        COALESCE(p.level, 1)::int AS author_level,
        sp.content,
        COALESCE(sp.content_type, 'text')::text AS content_type,
        -- BUG-17b: jsonb → text[] conversion. Defensive for non-array values.
        CASE
          WHEN sp.media_urls IS NULL                     THEN ARRAY[]::text[]
          WHEN jsonb_typeof(sp.media_urls) = 'array'     THEN
            ARRAY(SELECT jsonb_array_elements_text(sp.media_urls))
          ELSE ARRAY[]::text[]
        END AS media_urls,
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
