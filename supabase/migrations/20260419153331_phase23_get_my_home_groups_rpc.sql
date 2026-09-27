-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419153331 "phase23_get_my_home_groups_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 953d68982772e0e68100a94d41c897ce of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 23 — get_my_home_groups RPC
--  -----------------------------------------------------------------------
--  Returns all home groups the authenticated user has any relationship
--  with: owned, member (approved), or pending request. For each, includes
--  the user's role, status, the group's slug, and the NEXT upcoming game
--  (if any) so profile/navigation UI can link directly.
--
--  Auth: p_caller_user_id must match auth.uid().
-- =========================================================================

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
    my_role              text,        -- 'owner' | 'admin' | 'member'
    my_status            text,        -- 'approved' | 'pending' | 'declined' | 'banned'
    member_count         integer,
    upcoming_games_count integer,
    next_game            jsonb,       -- next scheduled/confirmed game or NULL
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
        -- Groups I own
        SELECT g.id,
               'owner'::text    AS my_role,
               'approved'::text AS my_status,
               g.created_at     AS joined_at
          FROM commander_home_groups g
         WHERE g.owner_id = p_caller_user_id
        UNION ALL
        -- Groups I'm a member of (any status)
        SELECT m.group_id,
               m.role::text,
               m.status::text,
               COALESCE(m.joined_at, m.created_at)
          FROM commander_home_members m
         WHERE m.user_id = p_caller_user_id
           -- Exclude banned — user shouldn't see banned memberships
           AND m.status <> 'banned'
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

REVOKE EXECUTE ON FUNCTION public.get_my_home_groups(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_home_groups(uuid) 
    TO authenticated, service_role;

COMMENT ON FUNCTION public.get_my_home_groups(uuid) IS
  'Phase 23: Returns all home groups the authenticated user owns, is a member of, or has pending requests in. Each row includes next upcoming game. Sorted by status (approved first), then role (owner first), then recency.';
