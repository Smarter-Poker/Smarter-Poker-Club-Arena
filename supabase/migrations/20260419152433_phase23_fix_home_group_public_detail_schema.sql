-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419152433 "phase23_fix_home_group_public_detail_schema"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 76d7c6add90b5e27512b1ce13dd6bca6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 23 — Fix get_home_group_public_detail schema mismatches
--  -----------------------------------------------------------------------
--  Previous version referenced rsvp_count (doesn't exist — split into
--  rsvp_yes/rsvp_maybe/rsvp_no) and joined reviews on group_id (reviews
--  link to game_id only). This corrected version:
--    - Aggregates rsvp_yes as the "committed" count
--    - Joins reviews → games → group to collect all group-level reviews
--    - Adds game title, neighborhood, end_time to the payload
-- =========================================================================

CREATE OR REPLACE FUNCTION public.get_home_group_public_detail(
    p_slug_or_id   text,
    p_viewer_id    uuid DEFAULT NULL,
    p_inactivity_days int DEFAULT 45
) RETURNS TABLE(
    group_id             uuid,
    slug                 text,
    name                 text,
    tagline              text,
    description          text,
    profile_photo_url    text,
    cover_photo_url      text,
    city                 text,
    state                text,
    default_game_type    text,
    default_stakes       text,
    typical_buyin_min    integer,
    typical_buyin_max    integer,
    max_players          integer,
    typical_day          text,
    typical_time         time,
    frequency            text,
    is_private           boolean,
    is_active            boolean,
    is_visible           boolean,
    visibility_reason    text,
    last_activity_at     timestamptz,
    member_count         integer,
    games_hosted         integer,
    upcoming_games_count integer,
    viewer_membership_role text,
    viewer_is_member       boolean,
    upcoming_games       jsonb,
    recent_reviews       jsonb,
    created_at           timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_group_id     uuid;
    v_is_member    boolean;
    v_member_role  text;
    v_is_visible   boolean;
    v_reason       text;
BEGIN
    BEGIN
        v_group_id := p_slug_or_id::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        SELECT g.id INTO v_group_id
          FROM commander_home_groups g
          JOIN social_pages sp
            ON sp.linked_entity_type = 'home_group'
           AND sp.linked_entity_id = g.id::text
         WHERE sp.slug = p_slug_or_id
         LIMIT 1;
    END;

    IF v_group_id IS NULL THEN
        RETURN;
    END IF;

    IF p_viewer_id IS NOT NULL THEN
        SELECT 
            CASE 
              WHEN g.owner_id = p_viewer_id THEN 'owner'
              ELSE m.role
            END
          INTO v_member_role
          FROM commander_home_groups g
          LEFT JOIN commander_home_members m
            ON m.group_id = g.id 
           AND m.user_id = p_viewer_id
           AND m.status = 'approved'
         WHERE g.id = v_group_id;
        v_is_member := (v_member_role IS NOT NULL);
    ELSE
        v_member_role := NULL;
        v_is_member := false;
    END IF;

    SELECT
        CASE
          WHEN g.is_private AND NOT v_is_member THEN false
          WHEN NOT g.is_active THEN false
          WHEN g.visibility_override_until IS NOT NULL 
               AND g.visibility_override_until > NOW() THEN true
          WHEN g.last_activity_at IS NULL THEN false
          WHEN g.last_activity_at < NOW() - (p_inactivity_days || ' days')::interval THEN false
          ELSE true
        END,
        CASE
          WHEN g.is_private AND NOT v_is_member THEN 'private'
          WHEN NOT g.is_active THEN 'inactive'
          WHEN g.visibility_override_until IS NOT NULL 
               AND g.visibility_override_until > NOW() THEN 'public'
          WHEN g.last_activity_at IS NULL THEN 'no_activity'
          WHEN g.last_activity_at < NOW() - (p_inactivity_days || ' days')::interval THEN 'stale'
          ELSE 'public'
        END
      INTO v_is_visible, v_reason
      FROM commander_home_groups g
     WHERE g.id = v_group_id;

    IF NOT v_is_visible AND NOT v_is_member THEN
        RETURN QUERY
        SELECT
            g.id,
            sp.slug::text,
            g.name::text,
            NULL::text, NULL::text,
            g.profile_photo_url::text, NULL::text,
            NULL::text, NULL::text,
            NULL::text, NULL::text, NULL::int, NULL::int, NULL::int, NULL::text, NULL::time, NULL::text,
            g.is_private, g.is_active, v_is_visible, v_reason,
            NULL::timestamptz, NULL::int, NULL::int, 0::int,
            v_member_role::text, v_is_member,
            '[]'::jsonb, '[]'::jsonb,
            g.created_at
          FROM commander_home_groups g
          LEFT JOIN social_pages sp
            ON sp.linked_entity_type = 'home_group'
           AND sp.linked_entity_id = g.id::text
         WHERE g.id = v_group_id;
    ELSE
        RETURN QUERY
        SELECT
            g.id,
            sp.slug::text,
            g.name::text,
            g.tagline::text,
            g.description::text,
            g.profile_photo_url::text,
            g.cover_photo_url::text,
            g.city::text,
            g.state::text,
            g.default_game_type::text,
            g.default_stakes::text,
            g.typical_buyin_min,
            g.typical_buyin_max,
            g.max_players,
            g.typical_day::text,
            g.typical_time,
            g.frequency::text,
            g.is_private,
            g.is_active,
            v_is_visible,
            v_reason,
            g.last_activity_at,
            g.member_count,
            g.games_hosted,
            COALESCE((
                SELECT COUNT(*)::int
                  FROM commander_home_games hg
                 WHERE hg.group_id = g.id
                   AND hg.status IN ('scheduled','confirmed')
                   AND hg.scheduled_date >= CURRENT_DATE
            ), 0),
            v_member_role::text,
            v_is_member,
            COALESCE((
                SELECT jsonb_agg(row_payload ORDER BY sort_key)
                  FROM (
                    SELECT
                        jsonb_build_object(
                            'id', hg.id,
                            'title', hg.title,
                            'scheduled_date', hg.scheduled_date,
                            'start_time', hg.start_time,
                            'end_time', hg.end_time,
                            'game_type', hg.game_type,
                            'stakes', hg.stakes,
                            'format', hg.format,
                            'buyin_min', hg.buyin_min,
                            'buyin_max', hg.buyin_max,
                            'max_players', hg.max_players,
                            'status', hg.status,
                            'neighborhood', hg.neighborhood,
                            'rsvp_yes', COALESCE(hg.rsvp_yes, 0),
                            'rsvp_maybe', COALESCE(hg.rsvp_maybe, 0),
                            'waitlist_count', COALESCE(hg.waitlist_count, 0)
                        ) AS row_payload,
                        (hg.scheduled_date::text || ' ' || COALESCE(hg.start_time::text, '00:00')) AS sort_key
                      FROM commander_home_games hg
                     WHERE hg.group_id = g.id
                       AND hg.status IN ('scheduled','confirmed')
                       AND hg.scheduled_date >= CURRENT_DATE
                     ORDER BY hg.scheduled_date, hg.start_time
                     LIMIT 5
                  ) AS upcoming
            ), '[]'::jsonb),
            COALESCE((
                SELECT jsonb_agg(row_payload ORDER BY created_at_sort DESC)
                  FROM (
                    SELECT
                        jsonb_build_object(
                            'id', r.id,
                            'rating', r.rating,
                            'review_text', r.review_text,
                            'created_at', r.created_at,
                            'reviewer_name', COALESCE(p.display_name, p.full_name, p.username, 'Anonymous'),
                            'game_title', hg.title,
                            'game_date', hg.scheduled_date
                        ) AS row_payload,
                        r.created_at AS created_at_sort
                      FROM commander_home_game_reviews r
                      JOIN commander_home_games hg ON hg.id = r.game_id
                      LEFT JOIN profiles p ON p.id = r.reviewer_id
                     WHERE hg.group_id = g.id
                     ORDER BY r.created_at DESC
                     LIMIT 3
                  ) AS reviews
            ), '[]'::jsonb),
            g.created_at
          FROM commander_home_groups g
          LEFT JOIN social_pages sp
            ON sp.linked_entity_type = 'home_group'
           AND sp.linked_entity_id = g.id::text
         WHERE g.id = v_group_id;
    END IF;
END;
$fn$;
