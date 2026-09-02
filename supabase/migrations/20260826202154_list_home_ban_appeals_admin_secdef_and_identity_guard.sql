-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826202154; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- TIER 3 (replaces a function body and its security context)
--
-- TWO FAULTS IN ONE FUNCTION, fixed together because fixing either alone is
-- wrong.
--
-- 1. IT CANNOT RUN. list_home_ban_appeals_admin is the only one of the seven
--    Home Games moderation RPCs that is SECURITY INVOKER. Called as the
--    signed-in admin -- which is what the corrected API route now does, and
--    what its own guard requires -- it fails with:
--
--        ERROR: permission denied for table commander_home_members
--
--    Verified for all three admin accounts on 2026-08-26. So the Appeals tab
--    has never listed anything.
--
-- 2. IT TRUSTS A PARAMETER FOR IDENTITY. The guard reads:
--
--        SELECT role INTO v_caller_role FROM profiles WHERE id = p_caller_user_id;
--        IF v_caller_role NOT IN ('admin','superadmin','god') THEN FORBIDDEN;
--
--    p_caller_user_id is supplied by the caller and is never compared against
--    auth.uid(). Today RLS on the underlying tables is what actually contains
--    it. Simply promoting the function to SECURITY DEFINER -- the obvious fix
--    for fault 1 -- would remove that containment and turn this into a clean
--    IDOR: any authenticated user could pass a god's uuid and read every ban
--    appeal on the platform, with the reporter's and the banned member's
--    display names, avatars and ban reasons.
--
--    So the identity check goes in at the same time. This is exactly the
--    guard its six siblings already carry:
--
--        IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
--          RAISE EXCEPTION 'UNAUTHORIZED';
--
-- Signature, return type, ordering, paging and filter semantics are unchanged.
-- The only differences are the added identity guard and SECURITY DEFINER.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── PRE-FLIGHT ────────────────────────────────────────────────────────
DO $$
DECLARE v_count int; v_secdef boolean; v_src text;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='list_home_ban_appeals_admin';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: expected exactly 1 list_home_ban_appeals_admin, found %.', v_count;
  END IF;

  SELECT p.prosecdef, p.prosrc INTO v_secdef, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='list_home_ban_appeals_admin';

  IF v_secdef THEN
    RAISE EXCEPTION 'PRE-FLIGHT: function is ALREADY SECURITY DEFINER. Someone changed it -- re-review before replacing.';
  END IF;
  IF v_src LIKE '%auth.uid()%' THEN
    RAISE EXCEPTION 'PRE-FLIGHT: function already checks auth.uid(). Re-review before replacing.';
  END IF;
  IF v_src NOT LIKE '%superadmin%' THEN
    RAISE EXCEPTION 'PRE-FLIGHT: function does not carry the expected role check. Re-review.';
  END IF;
END $$;

-- ─── CHANGE ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_home_ban_appeals_admin(
  p_caller_user_id uuid,
  p_status text DEFAULT NULL::text,
  p_group_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0)
 RETURNS TABLE(out_appeal_id uuid, out_group_id uuid, out_group_name text, out_user_id uuid,
               out_user_display text, out_user_avatar text, out_ban_reason text, out_appeal_text text,
               out_status text, out_reviewed_by uuid, out_reviewer_note text,
               out_created_at timestamp with time zone, out_reviewed_at timestamp with time zone,
               out_days_pending integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller_role text;
BEGIN
  IF p_caller_user_id IS NULL THEN
    RAISE EXCEPTION 'CALLER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- IDENTITY. Added 2026-08-26 with SECURITY DEFINER. Without this, the role
  -- check below is a check on a caller-supplied parameter, and a definer-rights
  -- function would let any signed-in user read every ban appeal by passing an
  -- admin's uuid. Same guard the other six moderation RPCs carry.
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
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
$function$;

GRANT EXECUTE ON FUNCTION
  public.list_home_ban_appeals_admin(uuid, text, uuid, integer, integer) TO authenticated;

-- ─── POST-APPLY ASSERTIONS ─────────────────────────────────────────────
DO $$
DECLARE v_secdef boolean; v_src text; v_grant boolean; v_ret text;
BEGIN
  SELECT p.prosecdef, p.prosrc, pg_get_function_result(p.oid)
    INTO v_secdef, v_src, v_ret
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='list_home_ban_appeals_admin';

  IF NOT v_secdef THEN RAISE EXCEPTION 'POST-APPLY: function is not SECURITY DEFINER.'; END IF;
  IF v_src NOT LIKE '%auth.uid()%' THEN RAISE EXCEPTION 'POST-APPLY: identity guard is missing.'; END IF;
  IF v_src NOT LIKE '%UNAUTHORIZED%' THEN RAISE EXCEPTION 'POST-APPLY: UNAUTHORIZED path is missing.'; END IF;
  IF v_ret NOT LIKE '%out_days_pending%' THEN RAISE EXCEPTION 'POST-APPLY: return signature changed.'; END IF;

  SELECT has_function_privilege('authenticated',
    'public.list_home_ban_appeals_admin(uuid, text, uuid, integer, integer)', 'EXECUTE') INTO v_grant;
  IF NOT v_grant THEN RAISE EXCEPTION 'POST-APPLY: authenticated cannot execute it.'; END IF;

  RAISE NOTICE 'POST-APPLY OK: SECURITY DEFINER with an auth.uid() identity guard.';
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK -- restores SECURITY INVOKER and removes the identity guard,
-- which re-breaks the Appeals tab. The IDOR only exists while the function is
-- SECURITY DEFINER, so reverting both together is safe.
-- Recreate from the definition captured in this migration's PRE-FLIGHT note:
-- drop the `SECURITY DEFINER` line and the auth.uid() block, leaving the rest.
-- ═══════════════════════════════════════════════════════════════════════
