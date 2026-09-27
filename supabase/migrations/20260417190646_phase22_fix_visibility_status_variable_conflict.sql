-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417190646 "phase22_fix_visibility_status_variable_conflict"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 08d2ca2d173ea95da60b8e95271e9225 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: variable/column ambiguity on last_activity_at. Rewrite with
-- `#variable_conflict use_column` + DECLARE local vars using distinct names
-- so the SELECT INTO targets local variables explicitly without shadowing.

CREATE OR REPLACE FUNCTION public.get_home_group_visibility_status(
    p_group_id         uuid,
    p_inactivity_days  int DEFAULT 45
)
RETURNS TABLE (
    is_currently_visible       boolean,
    reason_hidden              text,
    days_stale                 int,
    days_until_hidden          int,
    last_activity_at           timestamptz,
    visibility_override_until  timestamptz,
    threshold_days             int,
    is_override_active         boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
#variable_conflict use_column
DECLARE
    v_is_private         boolean;
    v_is_active          boolean;
    v_last_activity      timestamptz;
    v_created_at         timestamptz;
    v_override_until     timestamptz;
    v_days_stale         int;
    v_days_left          int;
    v_override_active    boolean;
    v_reason             text;
    v_visible            boolean;
BEGIN
    SELECT g.is_private, g.is_active, g.last_activity_at, g.created_at, g.visibility_override_until
      INTO v_is_private, v_is_active, v_last_activity, v_created_at, v_override_until
      FROM commander_home_groups g
     WHERE g.id = p_group_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT
            false, 'not_found'::text, NULL::int, NULL::int,
            NULL::timestamptz, NULL::timestamptz, p_inactivity_days, false;
        RETURN;
    END IF;

    v_override_active := (v_override_until IS NOT NULL AND v_override_until > NOW());

    IF v_last_activity IS NOT NULL THEN
        v_days_stale := EXTRACT(EPOCH FROM (NOW() - v_last_activity))::int / 86400;
    END IF;

    IF v_is_private THEN
        v_visible := false; v_reason := 'private'; v_days_left := NULL;
    ELSIF NOT v_is_active THEN
        v_visible := false; v_reason := 'inactive'; v_days_left := NULL;
    ELSIF v_override_active THEN
        v_visible := true;  v_reason := NULL; v_days_left := NULL;
    ELSIF v_last_activity IS NULL
          AND v_created_at < NOW() - (p_inactivity_days || ' days')::interval THEN
        v_visible := false; v_reason := 'no_activity'; v_days_left := 0;
    ELSIF v_last_activity IS NOT NULL AND v_days_stale > p_inactivity_days THEN
        v_visible := false; v_reason := 'stale'; v_days_left := 0;
    ELSE
        v_visible := true;  v_reason := NULL;
        IF v_last_activity IS NOT NULL THEN
            v_days_left := p_inactivity_days - v_days_stale;
        ELSE
            v_days_left := p_inactivity_days
                           - (EXTRACT(EPOCH FROM (NOW() - v_created_at))::int / 86400);
        END IF;
        IF v_days_left < 0 THEN v_days_left := 0; END IF;
    END IF;

    RETURN QUERY SELECT
        v_visible,
        v_reason,
        v_days_stale,
        v_days_left,
        v_last_activity,
        v_override_until,
        p_inactivity_days,
        v_override_active;
END;
$func$;

NOTIFY pgrst, 'reload schema';
