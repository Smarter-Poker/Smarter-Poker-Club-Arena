-- 20261019145553_club_members_reader_redacts_money
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-19 14:55:53 UTC.
--
-- WHY. ca_club_members (Club Dashboard "Players" tab, route
-- clubs/:clubId/dashboard-full) checked only ca_can_view_club and then returned
-- chip_balance and profit for EVERY member: a plain player read 200 of 200
-- balances. Its figures were also stale: hands from club_member_daily_stats
-- (8,586 against ~102,600 funded-club hands for one JAQK agent), profit from the
-- same stale table, last_active = club_members.last_active (the join time in
-- 2,006 of 2,007 rows), "seated" missed union tables, and NOT IN ('banned') let
-- suspended members through.
--
-- WHAT. Same signature and columns, so both callers keep working:
--   * money per row: the rule of ca_club_roster_access(club, target) IN
--     ('staff','downline','service'), evaluated once per call. Otherwise
--     balance, hands, Win/Loss and last active are NULL, and sorting by them
--     cannot rank hidden rows.
--   * hands: member_record_daily_facts at the club's launch accounting cutoff
--     (what ca_club_roster_rows and the member record read).
--   * Win/Loss: cash facts net + ca_club_member_tournament_money (the
--     ca_club_members_win_loss definition). A Win/Loss sort prices every visible
--     row; any other sort prices only the page.
--   * last active: greatest(last_login, last_seen, club_members.last_active_at).
--   * status IN ('active','approved'); seated/online as ca_club_roster_rows.
-- The Blacklist Manager picker only shows a name, so it gets its own
-- identity-only reader, ca_club_member_search, and no longer receives balances.
--
-- PROOF (production, BEGIN ... ROLLBACK, 2026-10-19 15:06 UTC, all 523 JAQK
-- rows and all 267 Midway Union rows): money rows player 0, agent 28 and 12
-- (self + downline), owner 523, union overseer 267; zero rows where money
-- visibility differs from ca_club_roster_access; zero rows where hands or
-- balance differ from ca_club_roster_rows; zero Win/Loss differences against
-- ca_club_members_win_loss('overall'). 50-row page 35-141 ms, Win/Loss sort
-- 359 ms for the owner. No data is written.
-- @live-proof: position('ca_club_member_tournament_money' IN pg_get_functiondef('public.ca_club_members(uuid,text,timestamp with time zone,integer,integer,text,text)'::regprocedure))>0 AND to_regprocedure('public.ca_club_member_search(uuid,text,integer)') IS NOT NULL AND NOT has_function_privilege('anon','public.ca_club_member_search(uuid,text,integer)','EXECUTE')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.ca_club_members(uuid,text,timestamp with time zone,integer,integer,text,text)'::regprocedure))
    <>'a23eef9d02c9efc0e4475561179303e9' THEN
   RAISE EXCEPTION 'ca_club_members preimage changed; qualify current definition';
 END IF;
 IF to_regprocedure('public.ca_club_member_search(uuid,text,integer)') IS NOT NULL THEN
   RAISE EXCEPTION 'ca_club_member_search already exists; qualify current definition';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.ca_club_members(p_club_id uuid, p_search text DEFAULT NULL::text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_sort text DEFAULT 'hands'::text, p_role text DEFAULT NULL::text)
 RETURNS TABLE(user_id uuid, display_name text, avatar_url text, is_horse boolean, is_online boolean, role text, status text, joined_at timestamp with time zone, last_active timestamp with time zone, chip_balance numeric, hands_played bigint, profit numeric, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_search   text := nullif(btrim(coalesce(p_search, '')), '');
  v_role     text := nullif(btrim(coalesce(p_role, '')), '');
  v_sort     text := lower(coalesce(p_sort, 'hands'));
  v_may_see  boolean := public.fn_can_see_horse_flag(p_club_id);
  v_actor    uuid := auth.uid();
  v_service  boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_all      boolean := false;
  v_agent    boolean := false;
  v_cutoff   timestamptz := public.fn_ca_launch_accounting_cutoff('club', p_club_id);
  v_from_day date := CASE WHEN p_since IS NULL THEN NULL ELSE (p_since AT TIME ZONE 'UTC')::date END;
  v_from_ts  timestamptz;
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  v_from_ts := CASE WHEN v_from_day IS NULL THEN NULL ELSE v_from_day::timestamp AT TIME ZONE 'UTC' END;

  -- MONEY IS A PER-ROW DECISION (2026-10-19). The same rule as
  -- ca_club_roster_access(p_club_id, target) IN ('staff','downline','service'),
  -- evaluated once per call instead of once per row: platform admin, union
  -- overseer and exact-club owner/co_owner/admin see every row; an exact-club
  -- agent sees themself and their active downline; everyone else sees identity
  -- and presence only. Balance, hands, Win/Loss and last active are NULL, and
  -- sorting by them cannot rank rows the viewer may not see.
  IF v_service THEN
    v_all := true;
  ELSIF v_actor IS NOT NULL THEN
    v_all := EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND coalesce(p.is_admin, false))
      OR coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false)
      OR EXISTS (SELECT 1 FROM public.club_members a
                  WHERE a.user_id = v_actor AND a.club_id = p_club_id
                    AND a.role IN ('owner', 'co_owner', 'admin')
                    AND coalesce(a.status, 'approved') IN ('active', 'approved'));
    IF NOT v_all THEN
      v_agent := EXISTS (SELECT 1 FROM public.club_members a
                          WHERE a.user_id = v_actor AND a.club_id = p_club_id
                            AND a.role IN ('super_agent', 'agent', 'sub_agent')
                            AND coalesce(a.status, 'approved') IN ('active', 'approved'));
    END IF;
  END IF;

  RETURN QUERY
  WITH RECURSIVE edges AS MATERIALIZED (
    SELECT cm.agent_id AS parent, cm.user_id AS child
      FROM public.club_members cm
     WHERE v_agent AND cm.club_id = p_club_id AND cm.agent_id IS NOT NULL
       AND cm.agent_id <> cm.user_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ), tree AS (
    SELECT e.child, 1 AS depth FROM edges e WHERE e.parent = v_actor
    UNION ALL
    SELECT e.child, t.depth + 1 FROM tree t JOIN edges e ON e.parent = t.child WHERE t.depth < 20
  ), downline AS MATERIALIZED (
    SELECT DISTINCT t.child AS uid FROM tree t
    UNION SELECT v_actor WHERE v_agent
  ), seated AS MATERIALIZED (
    -- Union tables file their seats under the member's club (ts.club_id), not
    -- the table's own club; count both, as ca_club_roster_rows does.
    SELECT DISTINCT live.uid
      FROM (
        SELECT ts.user_id AS uid
          FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND ts.club_id = p_club_id AND t.status IN ('waiting', 'running')
        UNION
        SELECT ts.user_id
          FROM public.tables t JOIN public.table_seats ts ON ts.table_id = t.id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND t.club_id = p_club_id AND t.status IN ('waiting', 'running')
      ) live
  ), roster AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id AS uid,
           coalesce(cm.role, 'member') AS m_role,
           coalesce(cm.status, 'approved') AS m_status,
           coalesce(cm.joined_at, cm.created_at) AS m_joined,
           cm.chip_balance::numeric AS m_chip,
           cm.last_active_at AS m_last_active_at,
           coalesce(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), cm.display_name, 'Player') AS m_name,
           pr.avatar_url AS m_avatar,
           (v_may_see AND coalesce(pr.is_horse, false)) AS m_horse,
           (s.uid IS NOT NULL
            OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')) AS m_online,
           greatest(pr.last_login, pr.last_seen, cm.last_active_at) AS m_last_active,
           (v_all OR d.uid IS NOT NULL) AS sensitive
      FROM public.club_members cm
      LEFT JOIN public.profiles pr ON pr.id = cm.user_id
      LEFT JOIN seated s ON s.uid = cm.user_id
      LEFT JOIN downline d ON d.uid = cm.user_id
     WHERE cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
       AND pr.status IS DISTINCT FROM 'deleted'
       AND (v_search IS NULL
            OR coalesce(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), cm.display_name, '') ILIKE '%' || v_search || '%')
       AND (v_role IS NULL OR coalesce(cm.role, 'member') = v_role)
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), facts AS MATERIALIZED (
    -- Funded-club daily facts, as ca_club_roster_rows and the member record read them.
    SELECT f.user_id AS uid,
           sum(f.hands)::bigint AS hands,
           coalesce(sum(f.net) FILTER (WHERE NOT f.is_mtt), 0) AS cash_net
      FROM public.member_record_daily_facts f
      JOIN roster r ON r.uid = f.user_id AND r.sensitive
     WHERE f.club_id = p_club_id
       AND f.accounting_cutoff IS NOT DISTINCT FROM v_cutoff
       AND (v_from_day IS NULL OR f.played_on >= v_from_day)
     GROUP BY f.user_id
  ), mtt_all AS MATERIALIZED (
    -- Only a Win/Loss ranking needs every visible row's tournament money; it
    -- reads ca_club_member_tournament_money itself, so the figure is the one
    -- the member record shows. Any other sort prices only the page below.
    SELECT r.uid, public.ca_club_member_tournament_money(p_club_id, r.uid, v_from_ts, NULL) AS net
      FROM roster r
     WHERE v_sort = 'profit' AND r.sensitive
  ), shaped AS MATERIALIZED (
    SELECT r.*,
           CASE WHEN r.sensitive THEN coalesce(fa.hands, 0) END AS v_hands,
           CASE WHEN r.sensitive THEN coalesce(fa.cash_net, 0) END AS v_cash,
           CASE WHEN r.sensitive THEN round(coalesce(fa.cash_net, 0) + coalesce(m.net, 0), 2) END AS v_rank_profit
      FROM roster r
      LEFT JOIN facts fa ON fa.uid = r.uid
      LEFT JOIN mtt_all m ON m.uid = r.uid
  ), counted AS (SELECT count(*) AS n FROM shaped),
  ordered AS MATERIALIZED (
    SELECT x.*,
           row_number() OVER (ORDER BY
             CASE WHEN v_sort = 'profit' THEN x.v_rank_profit END DESC NULLS LAST,
             CASE WHEN v_sort = 'hands'  THEN x.v_hands END DESC NULLS LAST,
             CASE WHEN v_sort = 'joined' THEN x.m_joined END DESC NULLS LAST,
             CASE WHEN v_sort = 'last_active' THEN CASE WHEN x.sensitive THEN x.m_last_active END END DESC NULLS LAST,
             CASE WHEN v_sort = 'name'   THEN lower(x.m_name) END ASC NULLS LAST,
             x.m_joined DESC NULLS LAST,
             x.uid) AS rn
      FROM shaped x
  ), page AS MATERIALIZED (
    SELECT o.* FROM ordered o
     WHERE o.rn >  greatest(coalesce(p_offset, 0), 0)
       AND o.rn <= greatest(coalesce(p_offset, 0), 0) + least(greatest(coalesce(p_limit, 50), 1), 200)
  )
  SELECT
    pg.uid, pg.m_name, pg.m_avatar, pg.m_horse, pg.m_online, pg.m_role, pg.m_status, pg.m_joined,
    CASE WHEN pg.sensitive THEN pg.m_last_active END,
    CASE WHEN pg.sensitive THEN coalesce(pg.m_chip, 0) END,
    pg.v_hands::bigint,
    CASE WHEN NOT pg.sensitive THEN NULL
         WHEN v_sort = 'profit' THEN pg.v_rank_profit
         ELSE round(pg.v_cash + public.ca_club_member_tournament_money(p_club_id, pg.uid, v_from_ts, NULL), 2)
    END,
    c.n
  FROM page pg
  CROSS JOIN counted c
  ORDER BY pg.rn;
END;
$function$;
CREATE OR REPLACE FUNCTION public.ca_club_member_search(p_club_id uuid, p_search text, p_limit integer DEFAULT 8)
 RETURNS TABLE(user_id uuid, display_name text, status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_search text := btrim(left(coalesce(p_search, ''), 120));
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  IF length(v_search) < 2 THEN
    RETURN;
  END IF;
  v_search := replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_');

  -- Identity only: who is in this club, by name. No balance, hands, result or
  -- activity column exists here to leak. Suspended members stay findable so a
  -- control decision can still be recorded against them; banned do not.
  RETURN QUERY
  SELECT n.uid, n.name, n.st
    FROM (
      SELECT DISTINCT ON (cm.user_id)
             cm.user_id AS uid,
             coalesce(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), cm.display_name, 'Player') AS name,
             coalesce(cm.status, 'approved') AS st
        FROM public.club_members cm
        LEFT JOIN public.profiles pr ON pr.id = cm.user_id
       WHERE cm.club_id = p_club_id
         AND coalesce(cm.status, 'approved') <> 'banned'
         AND pr.status IS DISTINCT FROM 'deleted'
       ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC
    ) n
   WHERE n.name ILIKE '%' || v_search || '%'
   ORDER BY lower(n.name), n.uid
   LIMIT least(greatest(coalesce(p_limit, 8), 1), 25);
END;
$function$;
REVOKE ALL ON FUNCTION public.ca_club_member_search(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_search(uuid, text, integer) TO authenticated, service_role;
COMMIT;
