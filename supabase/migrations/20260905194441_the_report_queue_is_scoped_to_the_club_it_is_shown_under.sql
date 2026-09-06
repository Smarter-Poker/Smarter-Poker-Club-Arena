-- ═══════════════════════════════════════════════════════════════════════════
--  THE REPORT QUEUE IS SCOPED TO THE CLUB IT IS SHOWN UNDER
--  Club Operations upgrade, the all-phase sweep. 2026-09-05.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `ReportReviewPage` is mounted at `/clubs/:clubId/reports`, sits inside the
-- club operations rail, and heads itself with that club's name and three
-- counts - In View, Pending, Actioned. It calls
--
--     supabase.rpc('fn_list_player_reports', { p_status: filter })
--
-- and that function takes NO CLUB ARGUMENT. It returns every report the caller
-- may moderate anywhere on the platform. `clubId` is used by the page only as
-- an `if` gate before the call, so an operator who runs four clubs sees one
-- pooled queue under all four club headers, and each header's counts describe
-- the pool rather than the club.
--
-- Nothing is exposed that the caller could not already see -
-- `fn_caller_can_moderate_user` is unchanged and still decides that - so this
-- is a correctness and comprehension fix, not a security one. But a count
-- presented as this club's must be this club's.
--
-- HOW A REPORT IS TIED TO A CLUB. `user_reports` carries no club column; the
-- link is the reported player's membership. A report is in scope for a club
-- when the reported user is a member of it (or of a club in the same union
-- scope, which is how every other operator surface in this workspace reads
-- "this club" - `fn_club_scope_ids`).
--
-- p_club_id DEFAULTS TO NULL, and null means the old behaviour: every report
-- the caller may moderate. The union and platform surfaces that call this
-- without a club keep working unchanged.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

CREATE OR REPLACE FUNCTION public.fn_list_player_reports(
  p_status text DEFAULT NULL::text,
  p_club_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, reporter_id uuid, reported_user_id uuid, reason text, details text,
               status text, admin_notes text, created_at timestamp with time zone,
               reviewed_at timestamp with time zone, reviewed_by uuid,
               reporter_username text, reported_username text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_scope uuid[];
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN RETURN; END IF;

  -- The club and every club in its union scope, exactly as the cashier, the
  -- vault and the roster read "this club".
  IF p_club_id IS NOT NULL THEN
    v_scope := public.fn_club_scope_ids(p_club_id);
  END IF;

  RETURN QUERY
    SELECT ur.id, ur.reporter_id, ur.reported_user_id, ur.reason, ur.details,
           ur.status, ur.admin_notes, ur.created_at, ur.reviewed_at, ur.reviewed_by,
           rep.username AS reporter_username,
           tgt.username AS reported_username
    FROM user_reports ur
    LEFT JOIN profiles rep ON rep.id = ur.reporter_id
    LEFT JOIN profiles tgt ON tgt.id = ur.reported_user_id
    WHERE public.fn_caller_can_moderate_user(ur.reported_user_id)
      AND (p_status IS NULL OR p_status = 'all'
           OR (p_status = 'pending' AND ur.status = 'pending')
           OR (p_status = 'reviewed' AND ur.status <> 'pending'))
      AND (v_scope IS NULL OR EXISTS (
            SELECT 1 FROM public.club_members cm
             WHERE cm.user_id = ur.reported_user_id
               AND cm.club_id = ANY (v_scope)))
    ORDER BY ur.created_at DESC
    LIMIT 100;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_list_player_reports(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_list_player_reports(text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_list_player_reports(text, uuid) IS
  'Player reports the caller may moderate, narrowed to one club and its union scope when p_club_id is given. The club surface shows per-club counts and used to call the unscoped form, so an operator running four clubs saw one pooled queue under all four headers.';

-- The single-argument form is dropped: it is the shape that made the club
-- surface lie, its only caller is being updated in the same change, and an
-- overload set where one member silently ignores the club is worse than one
-- signature that always asks.
DROP FUNCTION IF EXISTS public.fn_list_player_reports(text);

DO $$
DECLARE v_n int; v_src text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_list_player_reports';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one report lister, found % - an unscoped overload is still reachable', v_n;
  END IF;

  SELECT string_agg(line, chr(10)) INTO v_src
    FROM (SELECT line FROM regexp_split_to_table(
            (SELECT prosrc FROM pg_proc WHERE proname = 'fn_list_player_reports'
              AND pronamespace = 'public'::regnamespace), chr(10)) AS line
           WHERE btrim(line) NOT LIKE '--%') q;

  IF v_src NOT LIKE '%fn_club_scope_ids(p_club_id)%' THEN
    RAISE EXCEPTION 'the report queue does not narrow to the club it is asked about';
  END IF;
  IF v_src NOT LIKE '%fn_caller_can_moderate_user%' THEN
    RAISE EXCEPTION 'the moderation gate was lost while adding the club scope';
  END IF;
END $$;

COMMIT;
