-- One-time snapshot initialization after the short trigger-install transaction.
-- The facts and captured deltas are read from ONE statement snapshot. Adding
-- (snapshot facts - snapshot deltas) preserves every concurrent committed delta.
-- Never lock the hot facts table through the scan; never schedule a refresh.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtextextended('club_roster_hand_totals_initialization',0));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.club_roster_hand_totals_state WHERE singleton AND NOT initialized)
  THEN RAISE EXCEPTION 'Roster hand totals were already initialized or state is missing'; END IF;
  IF md5(pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure)) <> 'bf5b4a1d2b77baea48c0f3f63afc9333'
  THEN RAISE EXCEPTION 'Roster source changed after qualification'; END IF;
END $$;
WITH facts AS MATERIALIZED (
  SELECT club_id,user_id,sum(rake_paid) AS fees,count(*)::bigint AS hands
  FROM public.ca_hand_facts WHERE club_id IS NOT NULL GROUP BY club_id,user_id
), captured AS MATERIALIZED (
  SELECT club_id,user_id,fees,hands FROM public.club_roster_hand_totals
), baseline AS MATERIALIZED (
  SELECT coalesce(f.club_id,c.club_id) AS club_id,coalesce(f.user_id,c.user_id) AS user_id,
         coalesce(f.fees,0)-coalesce(c.fees,0) AS fees,
         coalesce(f.hands,0)-coalesce(c.hands,0) AS hands
  FROM facts f FULL JOIN captured c USING (club_id,user_id)
)
INSERT INTO public.club_roster_hand_totals AS totals(club_id,user_id,fees,hands)
SELECT club_id,user_id,fees,hands FROM baseline ORDER BY club_id,user_id
ON CONFLICT (club_id,user_id) DO UPDATE
SET fees=totals.fees+EXCLUDED.fees,hands=totals.hands+EXCLUDED.hands;
UPDATE public.club_roster_hand_totals_state SET initialized=true WHERE singleton;
CREATE OR REPLACE FUNCTION public.ca_club_roster_rows(p_club_id uuid)
 RETURNS TABLE(user_id uuid, management_club_id uuid, home_club_id uuid, home_club_name text, player_number text, alias text, username text, display_name text, avatar_url text, role text, role_rank integer, is_online boolean, is_seated boolean, chip_balance numeric, player_wallet numeric, agent_wallet numeric, promo_wallet numeric, total_fees numeric, downline_fees numeric, total_hands bigint, downline_direct integer, downline_total integer, upline_user_id uuid, upline_name text, joined_at timestamp with time zone, last_login timestamp with time zone, nickname text, remark text, can_view_financials boolean, can_view_notes boolean, in_viewer_downline boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[];
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_platform_admin boolean := false;
  v_union_staff boolean := false;
  v_needs_hierarchy boolean := false;
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN;
  END IF;

  IF NOT v_service AND v_actor IS NOT NULL THEN
    SELECT coalesce(p.is_admin, false)
      INTO v_platform_admin
      FROM public.profiles p
     WHERE p.id = v_actor;
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);
  END IF;

  v_needs_hierarchy := v_service OR v_platform_admin OR v_union_staff OR EXISTS (
    SELECT 1 FROM public.club_members viewer
     WHERE viewer.user_id = v_actor
       AND viewer.club_id = p_club_id
       AND viewer.role IN ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent')
       AND coalesce(viewer.status, 'approved') IN ('active', 'approved')
  );

  IF NOT v_service
     AND NOT v_platform_admin
     AND NOT v_union_staff
     AND (
       v_actor IS NULL OR NOT EXISTS (
         SELECT 1
           FROM public.club_members actor
          WHERE actor.user_id = v_actor
            AND actor.club_id = p_club_id
            AND coalesce(actor.status, 'approved') IN ('active', 'approved')
       )
     ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE base AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id AS m_user_id,
           cm.club_id AS m_club_id,
           cm.role AS m_role,
           cm.agent_id AS m_agent_id,
           cm.chip_balance AS m_chip_balance,
           cm.promo_balance AS m_promo_balance,
           cm.joined_at AS m_joined_at,
           cm.last_active_at AS m_last_active_at,
           cm.nickname AS m_nickname,
           cm.notes AS m_notes,
           cm.display_name AS m_display_name,
           public.fn_club_role_rank(cm.role) AS m_rank
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY cm.user_id,
              public.fn_club_role_rank(cm.role) DESC,
              cm.joined_at ASC,
              cm.club_id
  ),
  edges AS MATERIALIZED (
    SELECT DISTINCT cm.agent_id AS parent, cm.user_id AS child
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.agent_id IS NOT NULL
       AND cm.agent_id <> cm.user_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ),
  closure AS MATERIALIZED (
    SELECT e.parent AS root, e.child AS descendant, 1 AS depth FROM edges e WHERE v_needs_hierarchy
    UNION ALL
    SELECT c.root, e.child, c.depth + 1
      FROM closure c
      JOIN edges e ON e.parent = c.descendant
     WHERE c.depth < 20
  ),
  viewer_tree AS MATERIALIZED (
    SELECT DISTINCT c.descendant AS uid
      FROM closure c
     WHERE c.root = v_actor
  ),
  downlines AS MATERIALIZED (
    SELECT c.root AS uid,
           count(DISTINCT c.descendant) FILTER (WHERE c.depth = 1)::int AS direct_count,
           count(DISTINCT c.descendant)::int AS total_count
      FROM closure c
     GROUP BY c.root
  ),
  staff_clubs AS MATERIALIZED (
    SELECT DISTINCT cm.club_id
      FROM public.club_members cm
     WHERE cm.user_id = v_actor
       AND cm.club_id = p_club_id
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ),
  staff_targets AS MATERIALIZED (
    SELECT DISTINCT cm.user_id AS uid
      FROM public.club_members cm
     WHERE cm.club_id IN (SELECT sc.club_id FROM staff_clubs sc)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ),
  viewer_agent AS MATERIALIZED (
    SELECT EXISTS (
      SELECT 1
        FROM public.club_members cm
       WHERE cm.user_id = v_actor
         AND cm.club_id = p_club_id
         AND cm.role IN ('super_agent', 'agent', 'sub_agent')
         AND coalesce(cm.status, 'approved') IN ('active', 'approved')
    ) AS yes
  ),
  access AS MATERIALIZED (
    SELECT b.m_user_id AS uid,
           (
             v_service OR v_platform_admin OR v_union_staff
             OR st.uid IS NOT NULL
             OR vt.uid IS NOT NULL
             OR (b.m_user_id = v_actor AND va.yes)
           ) AS sensitive,
           (vt.uid IS NOT NULL) AS is_downline
      FROM base b
      CROSS JOIN viewer_agent va
      LEFT JOIN staff_targets st ON st.uid = b.m_user_id
      LEFT JOIN viewer_tree vt ON vt.uid = b.m_user_id
  ),
  seated AS MATERIALIZED (
    SELECT DISTINCT live.uid
      FROM (
        SELECT ts.user_id AS uid
          FROM public.table_seats ts
          JOIN public.tables t ON t.id = ts.table_id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND ts.club_id = p_club_id
           AND t.status IN ('waiting', 'running')
        UNION
        SELECT ts.user_id AS uid
          FROM public.tables t
          JOIN public.table_seats ts ON ts.table_id = t.id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND t.club_id = p_club_id
           AND t.status IN ('waiting', 'running')
      ) live
  ),
  member_wallets AS MATERIALIZED (
    SELECT cm.user_id AS uid,
           sum(coalesce(cm.chip_balance, 0)) AS player_total,
           sum(coalesce(cm.promo_balance, 0)) AS member_promo_total
      FROM public.club_members cm
      JOIN base b ON b.m_user_id = cm.user_id
      JOIN access ac ON ac.uid = cm.user_id AND ac.sensitive
     WHERE cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     GROUP BY cm.user_id
  ),
  agent_wallets AS MATERIALIZED (
    SELECT a.user_id AS uid,
           sum(coalesce(a.agent_wallet_balance, 0)) AS agent_total,
           sum(coalesce(a.promo_wallet_balance, 0)) AS agent_promo_total
      FROM public.agents a
      JOIN base b ON b.m_user_id = a.user_id
      JOIN access ac ON ac.uid = a.user_id AND ac.sensitive
     WHERE a.club_id = p_club_id
       AND coalesce(a.status, 'active') = 'active'
     GROUP BY a.user_id
  ),
  fees AS MATERIALIZED (
    SELECT r.user_id AS uid, r.fees AS fee_total, r.hands AS hand_total
      FROM public.club_roster_hand_totals r
      JOIN base b ON b.m_user_id = r.user_id
      JOIN access ac ON ac.uid = r.user_id AND ac.sensitive
     WHERE r.club_id = p_club_id
  ),
  downline_fee_totals AS MATERIALIZED (
    SELECT c.root AS uid, sum(f.fee_total) AS fee_total
      FROM closure c
      JOIN fees f ON f.uid = c.descendant
     GROUP BY c.root
  )
  SELECT
    b.m_user_id,
    b.m_club_id,
    b.m_club_id,
    cl.name::text,
    pr.player_number::text,
    coalesce(nullif(btrim(pr.alias), ''),
             nullif(btrim(b.m_display_name), ''),
             nullif(btrim(pr.display_name), ''),
             pr.username,
             'Unknown')::text,
    coalesce(pr.username, '')::text,
    coalesce(nullif(btrim(pr.display_name), ''), pr.username, '')::text,
    coalesce(nullif(pr.arena_avatar_url, ''), pr.avatar_url)::text,
    b.m_role::text,
    b.m_rank,
    (s.uid IS NOT NULL)
      OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes'),
    (s.uid IS NOT NULL),
    CASE WHEN ac.sensitive THEN coalesce(b.m_chip_balance, 0) END,
    CASE WHEN ac.sensitive THEN coalesce(mw.player_total, 0) END,
    CASE WHEN ac.sensitive THEN coalesce(aw.agent_total, 0) END,
    CASE WHEN ac.sensitive
         THEN coalesce(mw.member_promo_total, 0) + coalesce(aw.agent_promo_total, 0) END,
    CASE WHEN ac.sensitive THEN round(coalesce(f.fee_total, 0), 2) END,
    CASE WHEN ac.sensitive THEN round(coalesce(df.fee_total, 0), 2) END,
    CASE WHEN ac.sensitive THEN coalesce(f.hand_total, 0)::bigint END,
    CASE WHEN ac.sensitive THEN coalesce(d.direct_count, 0) END,
    CASE WHEN ac.sensitive THEN coalesce(d.total_count, 0) END,
    CASE WHEN ac.sensitive THEN b.m_agent_id END,
    CASE WHEN ac.sensitive THEN up.upline_name END,
    b.m_joined_at,
    CASE WHEN ac.sensitive
         THEN coalesce(pr.last_login, pr.last_seen, b.m_last_active_at) END,
    CASE WHEN ac.sensitive THEN b.m_nickname::text END,
    CASE WHEN ac.sensitive THEN b.m_notes::text END,
    ac.sensitive,
    ac.sensitive,
    ac.is_downline
  FROM base b
  JOIN access ac ON ac.uid = b.m_user_id
  LEFT JOIN public.profiles pr ON pr.id = b.m_user_id
  LEFT JOIN public.clubs cl ON cl.id = b.m_club_id
  LEFT JOIN seated s ON s.uid = b.m_user_id
  LEFT JOIN member_wallets mw ON mw.uid = b.m_user_id
  LEFT JOIN agent_wallets aw ON aw.uid = b.m_user_id
  LEFT JOIN fees f ON f.uid = b.m_user_id
  LEFT JOIN downlines d ON d.uid = b.m_user_id
  LEFT JOIN downline_fee_totals df ON df.uid = b.m_user_id
  LEFT JOIN LATERAL (
    SELECT coalesce(nullif(btrim(u.alias), ''),
                    nullif(btrim(u.display_name), ''),
                    u.username)::text AS upline_name
      FROM public.profiles u
     WHERE u.id = b.m_agent_id
  ) up ON true;
END;
$function$;

COMMIT;
