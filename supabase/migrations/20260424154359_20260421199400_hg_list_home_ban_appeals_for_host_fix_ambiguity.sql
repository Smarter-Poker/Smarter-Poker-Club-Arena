-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424154359 "20260421199400_hg_list_home_ban_appeals_for_host_fix_ambiguity"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2fc3b92b8df579f018f5145688fb2d7a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DROP FUNCTION IF EXISTS public.list_home_ban_appeals_for_host(uuid, text, integer, integer);

CREATE OR REPLACE FUNCTION public.list_home_ban_appeals_for_host(
  p_group_id uuid    DEFAULT NULL,
  p_status   text    DEFAULT 'pending',
  p_limit    integer DEFAULT 50,
  p_offset   integer DEFAULT 0
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
  v_uid uuid := auth.uid();
  v_staff_group_ids uuid[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='42501'; END IF;

  SELECT array_agg(gid) INTO v_staff_group_ids FROM (
    SELECT id AS gid FROM public.commander_home_groups WHERE owner_id = v_uid
    UNION
    SELECT group_id FROM public.commander_home_members
     WHERE user_id = v_uid AND role IN ('admin','co_host') AND status='approved'
  ) s;

  IF v_staff_group_ids IS NULL OR array_length(v_staff_group_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF p_group_id IS NOT NULL AND NOT (p_group_id = ANY(v_staff_group_ids)) THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF' USING ERRCODE='42501';
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
         a.reviewed_by, a.reviewer_note,
         a.created_at, a.reviewed_at,
         EXTRACT(DAY FROM (NOW() - a.created_at))::integer
    FROM public.commander_home_ban_appeals a
    JOIN public.commander_home_groups g ON g.id = a.group_id
    LEFT JOIN public.profiles p              ON p.id = a.user_id
    LEFT JOIN public.commander_home_members m ON m.group_id = a.group_id AND m.user_id = a.user_id
   WHERE a.group_id = ANY(v_staff_group_ids)
     AND (p_group_id IS NULL OR a.group_id = p_group_id)
     AND (p_status IS NULL OR a.status = p_status)
   ORDER BY CASE WHEN a.status='pending' THEN 0 ELSE 1 END, a.created_at ASC
   LIMIT p_limit OFFSET p_offset;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.list_home_ban_appeals_for_host(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_home_ban_appeals_for_host(uuid, text, integer, integer) TO authenticated, service_role;
