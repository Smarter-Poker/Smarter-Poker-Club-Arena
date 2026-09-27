-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424023529 "20260421188100_hg_fix_list_home_ban_appeals_admin_schema"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 272c1739b6f88aad53ddbf51974b6e20 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: ban_appeals columns are (reviewed_by, not reviewer_id). ban_reason
-- lives on commander_home_members. Re-author signature + body.
DROP FUNCTION IF EXISTS public.list_home_ban_appeals_admin(uuid, text, uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.list_home_ban_appeals_admin(
  p_caller_user_id uuid,
  p_status         text    DEFAULT NULL,
  p_group_id       uuid    DEFAULT NULL,
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
   reviewed_by     uuid,
   reviewer_note   text,
   created_at      timestamptz,
   reviewed_at     timestamptz,
   days_pending    integer
 )
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_role text := auth.role();
BEGIN
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

  p_limit  := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
  p_offset := GREATEST(0, COALESCE(p_offset, 0));

  RETURN QUERY
  SELECT
    a.id,
    a.group_id,
    g.name::text,
    a.user_id,
    COALESCE(p.display_name, p.full_name, p.username, 'Member')::text,
    p.avatar_url::text,
    m.ban_reason::text,
    a.appeal_text,
    a.status,
    a.reviewed_by,
    a.reviewer_note,
    a.created_at,
    a.reviewed_at,
    EXTRACT(DAY FROM (NOW() - a.created_at))::integer
  FROM commander_home_ban_appeals a
  JOIN commander_home_groups g ON g.id = a.group_id
  LEFT JOIN profiles p              ON p.id = a.user_id
  LEFT JOIN commander_home_members m ON m.group_id = a.group_id AND m.user_id = a.user_id
  WHERE (p_status IS NULL OR a.status = p_status)
    AND (p_group_id IS NULL OR a.group_id = p_group_id)
  ORDER BY
    CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END,
    a.created_at ASC
  LIMIT p_limit OFFSET p_offset;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.list_home_ban_appeals_admin(uuid, text, uuid, integer, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_home_ban_appeals_admin(uuid, text, uuid, integer, integer) TO authenticated, service_role;
