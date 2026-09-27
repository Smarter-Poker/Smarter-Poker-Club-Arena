-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419152335 "phase23_get_home_group_public_detail_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a89b88a433a1d4d53a0d1860910a4577 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 23 — get_home_group_public_detail RPC
--  -----------------------------------------------------------------------
--  Single round-trip fetch for the /hub/home-games/[slug] public page.
--  Replaces 4-5 separate queries the frontend would otherwise make.
--
--  Privacy rules enforced server-side:
--    - Private groups: only members (or owner) see full detail. Others get
--      minimal "invite only" payload with name/logo only.
--    - Inactive groups (is_active=false OR stale past threshold without
--      override): hidden from non-members unless invite code used.
--    - lat/lng NEVER returned — only city/state. Prevents dox-by-API.
--    - Member list NEVER returned — only counts.
--
--  Accepts either slug OR group UUID. Returns ONE row regardless.
--  p_viewer_id optional (anon ok).
-- =========================================================================

CREATE OR REPLACE FUNCTION public.get_home_group_public_detail(
    p_slug_or_id   text,
    p_viewer_id    uuid DEFAULT NULL,
    p_inactivity_days int DEFAULT 45
) RETURNS TABLE(
    -- Core
    group_id             uuid,
    slug                 text,
    name                 text,
    tagline              text,
    description          text,
    -- Branding
    profile_photo_url    text,
    cover_photo_url      text,
    -- Location (city/state only — never coordinates)
    city                 text,
    state                text,
    -- Game defaults
    default_game_type    text,
    default_stakes       text,
    typical_buyin_min    integer,
    typical_buyin_max    integer,
    max_players          integer,
    typical_day          text,
    typical_time         time,
    frequency            text,
    -- Status
    is_private           boolean,
    is_active            boolean,
    is_visible           boolean,       -- computed: active AND (not stale OR override)
    visibility_reason    text,          -- 'public' | 'stale' | 'inactive' | 'private' | 'no_activity'
    last_activity_at     timestamptz,
    -- Counts
    member_count         integer,
    games_hosted         integer,
    upcoming_games_count integer,
    -- Viewer context
    viewer_membership_role text,        -- 'owner' | 'admin' | 'co_host' | 'member' | NULL
    viewer_is_member       boolean,
    -- Payloads (nested JSON)
    upcoming_games       jsonb,         -- next 5 scheduled public games
    recent_reviews       jsonb,         -- last 3 public reviews
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
    -- Step 1: resolve slug or uuid to group_id
    -- Accept raw UUID string OR slug via social_pages lookup
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
        RETURN;  -- not found
    END IF;

    -- Step 2: determine viewer's membership relationship to the group
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

    -- Step 3: compute visibility
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

    -- Step 4: branch payload
    -- If viewer is NOT a member AND group is not visible → return minimal payload
    -- If viewer IS a member → return everything regardless of visibility
    IF NOT v_is_visible AND NOT v_is_member THEN
        RETURN QUERY
        SELECT
            g.id,
            sp.slug::text,
            g.name::text,
            NULL::text,  -- tagline hidden
            NULL::text,  -- description hidden
            g.profile_photo_url::text,
            NULL::text,  -- cover hidden
            NULL::text, NULL::text,  -- location hidden
            NULL::text, NULL::text, NULL::int, NULL::int, NULL::int, NULL::text, NULL::time, NULL::text,
            g.is_private,
            g.is_active,
            v_is_visible,
            v_reason,
            NULL::timestamptz,  -- last_activity hidden
            NULL::int, NULL::int,
            0::int,
            v_member_role::text,
            v_is_member,
            '[]'::jsonb,
            '[]'::jsonb,
            g.created_at
          FROM commander_home_groups g
          LEFT JOIN social_pages sp
            ON sp.linked_entity_type = 'home_group'
           AND sp.linked_entity_id = g.id::text
         WHERE g.id = v_group_id;
    ELSE
        -- Full payload
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
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id', hg.id,
                        'scheduled_date', hg.scheduled_date,
                        'start_time', hg.start_time,
                        'game_type', hg.game_type,
                        'stakes', hg.stakes,
                        'format', hg.format,
                        'buyin_min', hg.buyin_min,
                        'buyin_max', hg.buyin_max,
                        'max_players', hg.max_players,
                        'status', hg.status,
                        'rsvp_count', COALESCE(hg.rsvp_count, 0)
                    ) ORDER BY hg.scheduled_date, hg.start_time
                )
                  FROM commander_home_games hg
                 WHERE hg.group_id = g.id
                   AND hg.status IN ('scheduled','confirmed')
                   AND hg.scheduled_date >= CURRENT_DATE
                 LIMIT 5
            ), '[]'::jsonb),
            COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id', r.id,
                        'rating', r.rating,
                        'review_text', r.review_text,
                        'created_at', r.created_at,
                        'reviewer_name', COALESCE(p.display_name, p.username, 'Anonymous')
                    ) ORDER BY r.created_at DESC
                )
                  FROM commander_home_game_reviews r
                  LEFT JOIN profiles p ON p.id = r.reviewer_id
                 WHERE r.group_id = g.id
                 LIMIT 3
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

-- Clean ACL
REVOKE EXECUTE ON FUNCTION public.get_home_group_public_detail(text, uuid, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_home_group_public_detail(text, uuid, int) 
    TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_home_group_public_detail(text, uuid, int) IS
  'Phase 23: Public-facing home group detail fetch for /home-games/[slug] pages. Accepts slug or UUID. Privacy-aware: private groups show minimal payload to non-members. Stale groups hidden from non-members. Never returns lat/lng. One round-trip replacing 4-5 queries.';
