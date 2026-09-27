-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419153400 "phase23_fix_my_home_groups_dedup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2fc740554f4737a064f4442004e1b4ac of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: exclude owner-self rows from the members branch to prevent duplicates
-- when a user is both listed in commander_home_groups.owner_id AND has a
-- self-row in commander_home_members with role='owner'.
CREATE OR REPLACE FUNCTION public.get_my_home_groups(
    p_caller_user_id  uuid
) RETURNS TABLE(
    group_id             uuid,
    slug                 text,
    name                 text,
    profile_photo_url    text,
    city                 text,
    state                text,
    is_private           boolean,
    is_active            boolean,
    my_role              text,
    my_status            text,
    member_count         integer,
    upcoming_games_count integer,
    next_game            jsonb,
    last_activity_at     timestamptz,
    joined_at            timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    RETURN QUERY
    WITH my_rels AS (
        -- Branch 1: groups I own (authoritative via owner_id column)
        SELECT g.id,
               'owner'::text    AS my_role,
               'approved'::text AS my_status,
               g.created_at     AS joined_at
          FROM commander_home_groups g
         WHERE g.owner_id = p_caller_user_id
        UNION ALL
        -- Branch 2: groups I'm a member of BUT where I'm not the owner
        -- (avoids duplicates when owner also has a self-row with role='owner'
        -- in commander_home_members)
        SELECT m.group_id,
               m.role::text,
               m.status::text,
               COALESCE(m.joined_at, m.created_at)
          FROM commander_home_members m
          JOIN commander_home_groups g ON g.id = m.group_id
         WHERE m.user_id = p_caller_user_id
           AND m.status <> 'banned'
           AND g.owner_id <> p_caller_user_id  -- dedup guard
    )
    SELECT
        g.id,
        sp.slug::text,
        g.name::text,
        g.profile_photo_url::text,
        g.city::text,
        g.state::text,
        g.is_private,
        g.is_active,
        r.my_role,
        r.my_status,
        g.member_count,
        COALESCE((
            SELECT COUNT(*)::int
              FROM commander_home_games hg
             WHERE hg.group_id = g.id
               AND hg.status IN ('scheduled','confirmed')
               AND hg.scheduled_date >= CURRENT_DATE
        ), 0),
        (
            SELECT jsonb_build_object(
                'id', hg.id,
                'title', hg.title,
                'scheduled_date', hg.scheduled_date,
                'start_time', hg.start_time,
                'format', hg.format,
                'stakes', hg.stakes,
                'rsvp_yes', COALESCE(hg.rsvp_yes, 0),
                'max_players', hg.max_players
            )
              FROM commander_home_games hg
             WHERE hg.group_id = g.id
               AND hg.status IN ('scheduled','confirmed')
               AND hg.scheduled_date >= CURRENT_DATE
             ORDER BY hg.scheduled_date, hg.start_time
             LIMIT 1
        ),
        g.last_activity_at,
        r.joined_at
      FROM my_rels r
      JOIN commander_home_groups g ON g.id = r.id
      LEFT JOIN social_pages sp
        ON sp.linked_entity_type = 'home_group'
       AND sp.linked_entity_id = g.id::text
     ORDER BY 
        CASE r.my_status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        CASE r.my_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        g.last_activity_at DESC NULLS LAST;
END;
$fn$;
