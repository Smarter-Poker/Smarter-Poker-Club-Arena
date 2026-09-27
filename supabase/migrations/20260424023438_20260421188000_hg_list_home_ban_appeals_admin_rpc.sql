-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424023438 "20260421188000_hg_list_home_ban_appeals_admin_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0f782bd6958598e4a1d98c54c5b3b76a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Deeper hunt: /horses admin UI plan promises list_home_ban_appeals_admin,
-- but only review_home_ban_appeal and submit_home_ban_appeal existed.
-- Without this RPC, the admin queue page cannot be built.
--
-- Role gating: admin | superadmin | god in profiles.role.
-- service_role bypasses auth.uid() check (for server-side admin tooling).
-- Returns oldest-pending-first so admins clear backlog in arrival order.

CREATE OR REPLACE FUNCTION public.list_home_ban_appeals_admin(
  p_caller_user_id uuid,
  p_status         text    DEFAULT NULL,    -- filter: 'pending','approved','denied','withdrawn' or NULL=all
  p_group_id       uuid    DEFAULT NULL,    -- optional group filter
  p_limit          integer DEFAULT 50,
  p_offset         integer DEFAULT 0
)
 RETURNS TABLE (
   appeal_id       uuid,
   group_id        uuid,
   group_name      text,
   user_id         uuid,
   user_display    text,
   user_avatar     text,
   ban_reason      text,
   appeal_text     text,
   status          text,
   reviewer_id     uuid,
   reviewer_note   text,
   created_at      timestamptz,
   reviewed_at     timestamptz,
   days_pending    integer
 )
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_role text := auth.role();
BEGIN
  -- Caller identity + admin gating
  IF v_role <> 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller_user_id THEN
      RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles
                    WHERE id = p_caller_user_id
                      AND role IN ('admin','superadmin','god')) THEN
      RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Bound p_limit to [1, 200]
  p_limit := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
  p_offset := GREATEST(0, COALESCE(p_offset, 0));

  RETURN QUERY
  SELECT
    a.id                               AS appeal_id,
    a.group_id,
    g.name                             AS group_name,
    a.user_id,
    COALESCE(p.display_name, p.full_name, p.username, 'Member')::text AS user_display,
    p.avatar_url                       AS user_avatar,
    a.ban_reason,
    a.appeal_text,
    a.status,
    a.reviewer_id,
    a.reviewer_note,
    a.created_at,
    a.reviewed_at,
    EXTRACT(DAY FROM (NOW() - a.created_at))::integer AS days_pending
  FROM commander_home_ban_appeals a
  JOIN commander_home_groups g ON g.id = a.group_id
  LEFT JOIN profiles p ON p.id = a.user_id
  WHERE (p_status IS NULL OR a.status = p_status)
    AND (p_group_id IS NULL OR a.group_id = p_group_id)
  ORDER BY
    CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END, -- pending first
    a.created_at ASC
  LIMIT p_limit OFFSET p_offset;
END;
$fn$;

-- Grants: authenticated can call (body gates admin role); anon denied.
REVOKE EXECUTE ON FUNCTION public.list_home_ban_appeals_admin(uuid, text, uuid, integer, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_home_ban_appeals_admin(uuid, text, uuid, integer, integer) TO authenticated, service_role;
