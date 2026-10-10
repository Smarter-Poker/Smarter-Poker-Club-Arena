-- The record waits for its downline list, whose old fees CTE scanned millions
-- of retained facts. Read the exact installed projection instead. Hierarchy,
-- fees, visibility, output shape and lifetime semantics are unchanged.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.ca_club_member_downline(uuid,uuid)'::regprocedure))<>'861dfc051bc946722dadf28c45d3697c'
 THEN RAISE EXCEPTION 'Downline source changed after qualification'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.club_roster_hand_totals_state WHERE singleton AND initialized)
 THEN RAISE EXCEPTION 'Qualified retained totals are not initialized'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.ca_club_member_downline(p_club_id uuid, p_user_id uuid)
 RETURNS TABLE(user_id uuid, player_number text, alias text, username text, role text, role_rank integer, depth integer, chip_balance numeric, total_fees numeric, is_online boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_scope uuid[] := public.fn_club_scope_ids(p_club_id);
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
BEGIN
  IF v_access NOT IN ('staff', 'downline', 'service') OR v_scope IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH RECURSIVE edges AS MATERIALIZED (
    SELECT DISTINCT cm.user_id AS child, cm.agent_id AS parent
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id AND cm.agent_id IS NOT NULL AND cm.agent_id <> cm.user_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ), tree AS (
    SELECT e.child, 1 AS depth FROM edges e WHERE e.parent = p_user_id
    UNION ALL
    SELECT e.child, t.depth + 1 FROM tree t JOIN edges e ON e.parent = t.child WHERE t.depth < 20
  ), flat AS MATERIALIZED (
    SELECT t.child AS uid, min(t.depth)::int AS depth FROM tree t GROUP BY t.child
  ), mem AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id) cm.user_id AS uid, cm.role, cm.chip_balance,
           public.fn_club_role_rank(cm.role) AS role_rank
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id AND cm.user_id IN (SELECT f.uid FROM flat f)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), seated AS MATERIALIZED (
    SELECT DISTINCT ts.user_id AS uid FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL AND ts.user_id IN (SELECT f.uid FROM flat f)
       AND t.status IN ('waiting', 'running')
       AND (ts.club_id = p_club_id OR t.club_id = p_club_id)
  ), fees AS MATERIALIZED (
    SELECT r.user_id AS uid, r.fees AS fee_total
      FROM public.club_roster_hand_totals r
     WHERE r.club_id = p_club_id AND r.user_id IN (SELECT f.uid FROM flat f)
  )
  SELECT f.uid, pr.player_number::text,
         public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                              pr.first_name, pr.last_name, pr.full_name)::text,
         coalesce(pr.username, '')::text, coalesce(m.role, 'player')::text,
         coalesce(m.role_rank, 0), f.depth, coalesce(m.chip_balance, 0)::numeric,
         round(coalesce(fe.fee_total, 0), 2)::numeric,
         s.uid IS NOT NULL OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')
    FROM flat f LEFT JOIN mem m ON m.uid = f.uid LEFT JOIN public.profiles pr ON pr.id = f.uid
    LEFT JOIN seated s ON s.uid = f.uid LEFT JOIN fees fe ON fe.uid = f.uid
   ORDER BY f.depth, coalesce(m.role_rank, 0) DESC,
            lower(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name));
END;
$function$;
COMMIT;
