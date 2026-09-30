-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419205719 "phase29c_fix_game_title_column"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 15e0ea1445c68084fe6d90ad564f401b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.get_unified_user_activity(
    p_user_id uuid, p_limit int DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN 
        RAISE EXCEPTION 'UNAUTHORIZED'; 
    END IF;
    p_limit := LEAST(GREATEST(p_limit, 1), 200);

    WITH activity AS (
        SELECT 'home_game_rsvp' AS kind, r.responded_at AS ts,
               jsonb_build_object(
                   'game_id', r.game_id, 'game_title', g.title,
                   'game_type', g.game_type, 'format', g.format,
                   'group_id', g.group_id, 'group_name', hg.name,
                   'response', r.response, 'checked_in', r.checked_in_at IS NOT NULL
               ) AS payload
          FROM commander_home_rsvps r
          JOIN commander_home_games g ON g.id = r.game_id
          JOIN commander_home_groups hg ON hg.id = g.group_id
         WHERE r.user_id = p_user_id

        UNION ALL
        SELECT 'home_group_joined', m.joined_at,
               jsonb_build_object('group_id', g.id, 'group_name', g.name, 'role', m.role)
          FROM commander_home_members m
          JOIN commander_home_groups g ON g.id = m.group_id
         WHERE m.user_id = p_user_id AND m.status = 'approved'

        UNION ALL
        SELECT 'badge_earned', earned_at,
               jsonb_build_object('badge_key', badge_key, 'metadata', metadata)
          FROM commander_home_user_badges WHERE user_id = p_user_id

        UNION ALL
        SELECT 'venue_followed', f.followed_at,
               jsonb_build_object('venue_id', v.id, 'name', v.name,
                                  'slug', v.slug, 'city', v.city, 'state', v.state)
          FROM commander_venue_followers f
          JOIN poker_venues v ON v.id = f.venue_id
         WHERE f.user_id = p_user_id

        UNION ALL
        SELECT 'venue_review_written', created_at,
               jsonb_build_object('venue_id', venue_id, 'rating', overall_rating, 'title', title)
          FROM commander_venue_reviews
         WHERE reviewer_id = p_user_id AND is_published = true

        UNION ALL
        SELECT 'venue_post_published', created_at,
               jsonb_build_object('venue_id', venue_id, 'post_type', post_type,
                                  'content', substr(content, 1, 120))
          FROM commander_venue_posts
         WHERE author_id = p_user_id AND is_published = true

        UNION ALL
        SELECT 'diamonds_awarded', created_at,
               jsonb_build_object('amount', amount, 'source', source, 'metadata', metadata)
          FROM diamond_transactions
         WHERE user_id = p_user_id AND amount > 0
    )
    SELECT jsonb_build_object(
        'generated_at', now(),
        'user_id', p_user_id,
        'count', (SELECT COUNT(*) FROM activity),
        'items', (SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) 
                    FROM (SELECT kind, ts, payload FROM activity 
                           ORDER BY ts DESC NULLS LAST LIMIT p_limit) t)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
