-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417190616 "phase22_host_dashboard_helpers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d9daa56cd150cb1a5134959af4fab6f8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Host dashboard helpers
--  -----------------------------------------------------------------------
--  Two helpers the upcoming host-facing UI needs:
--
--  1. get_home_group_visibility_status(group_id)
--       - Read-only, returns computed visibility state for a group
--       - Tells the host WHY their group is hidden (private / inactive /
--         stale / no activity yet) and HOW MANY DAYS until auto-hide hits
--       - Powers "Your group will stop appearing in discovery in N days"
--         banner on the Club Commander home-game dashboard
--
--  2. revive_home_group(group_id, caller_user_id)
--       - Owner-gated write that bumps last_activity_at = NOW()
--       - For the host's "Keep my group visible" button on the dashboard
--       - The API handler must pre-auth the caller and pass the verified
--         user_id; the function independently re-checks that user is the
--         group owner before bumping, as defense-in-depth
--       - Returns the new last_activity_at timestamp on success
-- =========================================================================


-- ─── 1. get_home_group_visibility_status ────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_home_group_visibility_status(
    p_group_id         uuid,
    p_inactivity_days  int DEFAULT 45
)
RETURNS TABLE (
    is_currently_visible       boolean,
    reason_hidden              text,       -- NULL if visible, else one of: private|inactive|stale|no_activity|not_found
    days_stale                 int,        -- days since last_activity_at (NULL if never had activity)
    days_until_hidden          int,        -- days until stale threshold hits; 0 if already past, NULL if override active or already hidden
    last_activity_at           timestamptz,
    visibility_override_until  timestamptz,
    threshold_days             int,
    is_override_active         boolean     -- true if visibility_override_until > NOW()
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    g RECORD;
    v_days_stale int;
    v_days_left  int;
    v_override_active boolean;
    v_reason text;
    v_visible boolean;
BEGIN
    SELECT is_private, is_active, last_activity_at, created_at, visibility_override_until
      INTO g
      FROM commander_home_groups
     WHERE id = p_group_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT
            false, 'not_found'::text, NULL::int, NULL::int,
            NULL::timestamptz, NULL::timestamptz, p_inactivity_days, false;
        RETURN;
    END IF;

    v_override_active := (g.visibility_override_until IS NOT NULL AND g.visibility_override_until > NOW());

    IF g.last_activity_at IS NOT NULL THEN
        v_days_stale := EXTRACT(EPOCH FROM (NOW() - g.last_activity_at))::int / 86400;
    END IF;

    IF g.is_private THEN
        v_visible := false;
        v_reason  := 'private';
        v_days_left := NULL;
    ELSIF NOT g.is_active THEN
        v_visible := false;
        v_reason  := 'inactive';
        v_days_left := NULL;
    ELSIF v_override_active THEN
        v_visible := true;
        v_reason  := NULL;
        v_days_left := NULL;      -- override in effect; activity timer is paused
    ELSIF g.last_activity_at IS NULL AND g.created_at < NOW() - (p_inactivity_days || ' days')::interval THEN
        v_visible := false;
        v_reason  := 'no_activity';
        v_days_left := 0;
    ELSIF g.last_activity_at IS NOT NULL AND v_days_stale > p_inactivity_days THEN
        v_visible := false;
        v_reason  := 'stale';
        v_days_left := 0;
    ELSE
        v_visible := true;
        v_reason  := NULL;
        -- How many days until hidden?
        IF g.last_activity_at IS NOT NULL THEN
            v_days_left := p_inactivity_days - v_days_stale;
        ELSE
            v_days_left := p_inactivity_days - (EXTRACT(EPOCH FROM (NOW() - g.created_at))::int / 86400);
        END IF;
        IF v_days_left < 0 THEN v_days_left := 0; END IF;
    END IF;

    RETURN QUERY SELECT
        v_visible,
        v_reason,
        v_days_stale,
        v_days_left,
        g.last_activity_at,
        g.visibility_override_until,
        p_inactivity_days,
        v_override_active;
END;
$func$;

COMMENT ON FUNCTION public.get_home_group_visibility_status(uuid, int) IS
  'Phase 22 helper. Returns computed visibility state for a home group: whether it currently surfaces in discovery, why not if not, how many days before auto-hide kicks in. Safe to expose to the group owner and group admins; does not return any user-identifying info.';

GRANT EXECUTE ON FUNCTION public.get_home_group_visibility_status(uuid, int)
    TO authenticated, service_role;


-- ─── 2. revive_home_group ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revive_home_group(
    p_group_id         uuid,
    p_caller_user_id   uuid
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    g_owner_id uuid;
    g_is_active boolean;
    new_ts timestamptz;
BEGIN
    IF p_group_id IS NULL OR p_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'revive_home_group: both p_group_id and p_caller_user_id are required'
          USING ERRCODE = '22004';
    END IF;

    SELECT owner_id, is_active
      INTO g_owner_id, g_is_active
      FROM commander_home_groups
     WHERE id = p_group_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'revive_home_group: home group % not found', p_group_id
          USING ERRCODE = 'P0002';
    END IF;

    IF NOT g_is_active THEN
        RAISE EXCEPTION 'revive_home_group: group is deactivated and cannot be revived by host'
          USING ERRCODE = '22023';
    END IF;

    -- Authorization: caller must be the group owner OR a group admin
    IF p_caller_user_id <> g_owner_id
       AND NOT EXISTS (
           SELECT 1 FROM commander_home_members m
            WHERE m.group_id = p_group_id
              AND m.user_id  = p_caller_user_id
              AND m.status   = 'approved'
              AND m.role     IN ('admin', 'co_host')
       )
    THEN
        RAISE EXCEPTION 'revive_home_group: caller is not authorized for this group'
          USING ERRCODE = '42501';
    END IF;

    UPDATE commander_home_groups
       SET last_activity_at = NOW(),
           updated_at       = NOW()
     WHERE id = p_group_id
     RETURNING last_activity_at INTO new_ts;

    RETURN new_ts;
END;
$func$;

COMMENT ON FUNCTION public.revive_home_group(uuid, uuid) IS
  'Phase 22. Owner/admin-gated "keep my group visible" action. API handler pre-authenticates the caller and passes the verified user_id; this function re-verifies ownership as defense-in-depth before bumping last_activity_at=NOW(). Used by the host dashboard "Revive Group" button. Raises 42501 on auth failure.';

-- authenticated role only. API handlers calling via service_role also work.
GRANT EXECUTE ON FUNCTION public.revive_home_group(uuid, uuid)
    TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
