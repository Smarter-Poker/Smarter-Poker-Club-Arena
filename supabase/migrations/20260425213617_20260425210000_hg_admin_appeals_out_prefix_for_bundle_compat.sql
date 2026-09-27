-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260425213617 "20260425210000_hg_admin_appeals_out_prefix_for_bundle_compat"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fceea24f2a484336f5dd5ddf0d61ffbb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX: /horses/hg-moderation Appeals tab bundle reads out_* prefixed
-- columns (out_appeal_id, out_group_name, out_user_display, out_ban_reason,
-- out_appeal_text, out_status, out_days_pending) but list_home_ban_appeals_admin
-- returns plain column names. Currently the bundle gets undefined for every
-- field and renders empty rows.
--
-- Fix: rename columns to use out_* prefix, matching list_home_ban_appeals_for_host.
-- This makes both host-scoped and admin RPCs return the same shape, simplifies
-- the bundle code, and unblocks the /horses Appeals tab.
--
-- Risk: if any other caller of this RPC reads non-prefixed columns, they break.
-- The function is admin-only and named *_admin — only consumer is the
-- /api/horses/hg-appeals route handler. AG should grep for any other callers
-- before this lands; if found, swap them to read out_* names.

DROP FUNCTION IF EXISTS public.list_home_ban_appeals_admin(uuid, text, uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.list_home_ban_appeals_admin(
  p_caller_user_id uuid,
  p_status         text DEFAULT NULL,
  p_group_id       uuid DEFAULT NULL,
  p_limit          integer DEFAULT 50,
  p_offset         integer DEFAULT 0
)
 RETURNS TABLE (
   out_appeal_id     uuid,
   out_group_id      uuid,
   out_group_name    text,
   out_user_id       uuid,
   out_user_display  text,
   out_user_avatar   text,
   out_ban_reason    text,
   out_appeal_text   text,
   out_status        text,
   out_reviewed_by   uuid,
   out_reviewer_note text,
   out_created_at    timestamptz,
   out_reviewed_at   timestamptz,
   out_days_pending  integer
 )
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_caller_role text;
BEGIN
  IF p_caller_user_id IS NULL THEN
    RAISE EXCEPTION 'CALLER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- Require admin/superadmin/god
  SELECT role INTO v_caller_role FROM public.profiles WHERE id = p_caller_user_id;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin','superadmin','god') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  p_limit  := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
  p_offset := GREATEST(0, COALESCE(p_offset, 0));

  RETURN QUERY
  SELECT a.id,
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
    FROM public.commander_home_ban_appeals a
    JOIN public.commander_home_groups g ON g.id = a.group_id
    LEFT JOIN public.profiles p              ON p.id = a.user_id
    LEFT JOIN public.commander_home_members m ON m.group_id = a.group_id AND m.user_id = a.user_id
   WHERE (p_group_id IS NULL OR a.group_id = p_group_id)
     AND (p_status IS NULL OR p_status = '' OR a.status = p_status)
   ORDER BY CASE WHEN a.status='pending' THEN 0 ELSE 1 END, a.created_at ASC
   LIMIT p_limit OFFSET p_offset;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.list_home_ban_appeals_admin(uuid, text, uuid, integer, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_home_ban_appeals_admin(uuid, text, uuid, integer, integer) TO authenticated, service_role;
