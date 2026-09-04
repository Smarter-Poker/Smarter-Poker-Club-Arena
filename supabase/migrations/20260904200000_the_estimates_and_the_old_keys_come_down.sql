-- THE ESTIMATES AND THE OLD KEYS COME DOWN, AND THE ROSTER SUMMARY COUNTS
-- THE CLUB THE DIRECTORY LISTS.
--
-- Loose ends from phases 3, 4 and 5 of the Club Operations upgrade, closed
-- together on 2026-09-04 once each phase's client had published.
--
-- 1. fn_ca_agent_payables carried `estimate` / `total_estimate` - the weekly
--    rake times commission rate that the Payouts tab printed before phase 3
--    read the ledger - "for one release", so an operator reconciling against
--    the old figure would see both. Phase 3 published on 2026-09-03; the
--    release is over. The cap rises from 200 to 500 rows: the read comes off
--    agent_commission_unsettled_rollup now and costs the same at any size.
-- 2. ca_club_tournaments carried `completed_30d` / `prize_pool_30d` beside
--    `completed_in_window` / `prize_pool_in_window` for the bundle that
--    predated phase 4. Phase 4 published on 2026-09-04 (63046772a).
-- 3. ca_club_member_statistics carried `total_games` / `total_hands` /
--    `wins` / `winner` beside `hands` / `hands_won`. Phase 5 published on
--    2026-09-04 (18fc9a062).
-- 4. ca_club_members_summary counted `cm.club_id = ANY(v_scope)` while
--    ca_club_roster_rows, the directory it heads, was patched on 2026-09-01
--    to `= p_club_id`. On a union page "Total Members" and the directory's
--    "N Results" therefore counted different sets. The viewer's own role and
--    capabilities are still resolved across the scope (a union overseer has
--    no row in the member club); the COUNTS are of this club.
--
-- Bodies otherwise unchanged. Grants restated for the definer gate.

BEGIN;

-- ── 1. payables ──
CREATE OR REPLACE FUNCTION public.fn_ca_agent_payables(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows      jsonb;
  v_owed      numeric;
  v_count     bigint;
  v_agents    integer;
  v_oldest    timestamptz;
  v_checked   timestamptz;
  -- 500, up from 200: the read comes off the rollup now and costs the same
  -- at any size. Only 32 agents exist at this club today.
  v_cap constant integer := 500;
BEGIN
  IF NOT fn_ca_can_manage_agents(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  WITH ranked AS (
    SELECT a.id,
           a.user_id,
           a.role,
           coalesce(a.status, 'active') AS status,
           coalesce(a.is_prepaid, false) AS is_prepaid,
           coalesce(a.credit_limit, 0)   AS credit_limit,
           coalesce(a.credit_used, 0)    AS credit_used,
           coalesce(a.commission_rate, 0) AS commission_rate,
           coalesce(a.player_rakeback_rate, 0) AS player_rakeback_rate,
           coalesce(a.total_players, 0)  AS total_players,
           coalesce(o.owed, 0)           AS owed,
           coalesce(o.rows_behind, 0)    AS rows_behind,
           o.oldest_unsettled            AS oldest,
           o.updated_at                  AS checked,
           coalesce(
             nullif(btrim(pr.display_name), ''),
             nullif(btrim(pr.alias), ''),
             nullif(btrim(pr.username), ''),
             'Member') AS name,
           row_number() OVER (ORDER BY coalesce(o.owed, 0) DESC, a.created_at) AS rn
      FROM agents a
      LEFT JOIN agent_commission_unsettled_rollup o
             ON o.club_id = p_club_id AND o.user_id = a.user_id
      LEFT JOIN profiles pr ON pr.id = a.user_id
     WHERE a.club_id = p_club_id
  )
  SELECT
    coalesce(jsonb_agg(
      jsonb_build_object(
        'agent_id', r.id,
        'user_id', r.user_id,
        'name', r.name,
        'role', r.role,
        'status', r.status,
        'is_prepaid', r.is_prepaid,
        'credit_limit', r.credit_limit,
        'credit_used', r.credit_used,
        'credit_available', greatest(r.credit_limit - r.credit_used, 0),
        'utilization', CASE WHEN r.credit_limit > 0
                            THEN round(r.credit_used / r.credit_limit, 4)
                            ELSE 0 END,
        'commission_rate', r.commission_rate,
        'player_rakeback_rate', r.player_rakeback_rate,
        'total_players', r.total_players,
        'owed', round(r.owed, 2),
        'rows_behind', r.rows_behind,
        'oldest_unsettled', r.oldest)
      ORDER BY r.rn) FILTER (WHERE r.rn <= v_cap), '[]'::jsonb),
    count(*)::integer,
    round(sum(r.owed), 2),
    sum(r.rows_behind),
    min(r.oldest),
    max(r.checked)
    INTO v_rows, v_agents, v_owed, v_count, v_oldest, v_checked
  FROM ranked r;

  RETURN jsonb_build_object(
    'agents', coalesce(v_agents, 0),
    'cap', v_cap,
    'total_owed', coalesce(v_owed, 0),
    'total_rows', coalesce(v_count, 0),
    'oldest_unsettled', v_oldest,
    'rollup_checked_at', v_checked,
    'rows', v_rows,
    'generated_at', now());
END;
$function$;

-- ── 2. tournaments ──
CREATE OR REPLACE FUNCTION public.ca_club_tournaments(
  p_club_id uuid,
  p_limit integer DEFAULT 20,
  p_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_union uuid;
  v_cap integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT union_id INTO v_union FROM clubs WHERE id = p_club_id;

  WITH scoped AS (
    SELECT t.*
    FROM tournaments t
    WHERE t.club_id = p_club_id
       OR (v_union IS NOT NULL AND t.union_id = v_union)
  ),
  live AS (
    SELECT t.id, t.name, t.status,
           coalesce(t.variant, t.game_type) AS variant,
           coalesce(t.buy_in_amount, 0) AS buy_in,
           coalesce(t.prize_pool, 0) AS prize_pool,
           coalesce(t.current_players, 0) AS players,
           t.max_players, t.start_time
    FROM scoped t
    WHERE t.status IN ('running', 'registering', 'late_reg', 'starting', 'scheduled')
    ORDER BY t.start_time
    LIMIT v_cap
  ),
  recent AS (
    SELECT t.id, t.name, t.status,
           coalesce(t.variant, t.game_type) AS variant,
           coalesce(t.buy_in_amount, 0) AS buy_in,
           coalesce(t.prize_pool, 0) AS prize_pool,
           coalesce(t.current_players, 0) AS players,
           t.ended_at
    FROM scoped t
    WHERE t.ended_at IS NOT NULL AND t.ended_at > v_from
    ORDER BY t.ended_at DESC
    LIMIT v_cap
  )
  SELECT jsonb_build_object(
    'live', coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.start_time) FROM live l), '[]'::jsonb),
    'recent', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.ended_at DESC) FROM recent r), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'window_days', v_days,
        'live_count', count(*) FILTER (WHERE t.status IN ('running','registering','late_reg','starting','scheduled')),
        'completed_in_window', count(*) FILTER (WHERE t.ended_at IS NOT NULL AND t.ended_at > v_from),
        'prize_pool_in_window', coalesce(sum(t.prize_pool) FILTER (WHERE t.ended_at IS NOT NULL AND t.ended_at > v_from), 0)
      )
      FROM scoped t
    )
  ) INTO v;

  RETURN v;
END;
$function$;

-- ── 3. statistics ──
CREATE OR REPLACE FUNCTION public.ca_club_member_statistics(
  p_club_id uuid, p_user_id uuid, p_variant text DEFAULT NULL::text,
  p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_variant text := NULLIF(lower(btrim(COALESCE(p_variant, ''))), '');
  v_from timestamptz := CASE WHEN p_from IS NULL THEN NULL ELSE p_from::timestamp AT TIME ZONE 'UTC' END;
  v_to timestamptz := CASE WHEN p_to IS NULL THEN NULL ELSE (p_to + 1)::timestamp AT TIME ZONE 'UTC' END;
  v_viewer_is_member boolean;
  v_target_is_member boolean;
  v_out jsonb;
BEGIN
  IF v_access NOT IN ('staff','downline','service') THEN
    -- A member of the club asking about somebody who is not one is told so;
    -- anyone else is told only that they may not look.
    v_viewer_is_member := auth.uid() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
         AND coalesce(cm.status, 'approved') IN ('active', 'approved'));
    v_target_is_member := EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id
         AND coalesce(cm.status, 'approved') IN ('active', 'approved'));
    RETURN jsonb_build_object(
      'authorized', false,
      'reason', CASE WHEN v_viewer_is_member AND NOT v_target_is_member
                     THEN 'not_member' ELSE 'restricted' END);
  END IF;

  WITH agg AS (
    SELECT count(DISTINCT f.hand_id)::bigint hands,
           count(DISTINCT f.hand_id) FILTER (WHERE f.net > 0)::bigint wins,
           count(*) FILTER (WHERE f.vpip)::bigint vpip_hands,
           count(*) FILTER (WHERE f.pfr)::bigint pfr_hands,
           count(*) FILTER (WHERE f.three_bet)::bigint tb_hands,
           -- faced_three_bet: this player OPENED and was 3-bet. The
           -- denominator of fold-to-3-bet, never of 3-bet.
           count(*) FILTER (WHERE f.faced_three_bet)::bigint faced_tb,
           count(*) FILTER (WHERE f.folded_to_three_bet)::bigint folded_tb,
           count(*) FILTER (WHERE f.cbet_flop)::bigint cb_hands,
           count(*) FILTER (WHERE f.had_cbet_flop_opp)::bigint cb_opps,
           COALESCE(sum(f.net),0) net, COALESCE(sum(f.rake_paid),0) fees
      FROM public.ca_hand_facts f
     WHERE f.club_id = p_club_id AND f.user_id = p_user_id
       AND (v_variant IS NULL OR v_variant = 'all' OR lower(f.game_variant) = v_variant)
       AND (v_from IS NULL OR f.played_at >= v_from) AND (v_to IS NULL OR f.played_at < v_to)
  ), vars AS (
    SELECT COALESCE(jsonb_agg(v.game_variant ORDER BY v.game_variant), '[]'::jsonb) list
      FROM (SELECT DISTINCT lower(f.game_variant) game_variant FROM public.ca_hand_facts f
             WHERE f.club_id = p_club_id AND f.user_id = p_user_id
               AND f.game_variant IS NOT NULL) v
  )
  SELECT jsonb_build_object(
    'authorized', true, 'variant', COALESCE(v_variant,'all'), 'variants', vars.list,
    'hands', a.hands,
    'hands_won', a.wins,
    'win_rate', COALESCE(round(100.0*a.wins/NULLIF(a.hands,0),2),0),
    'vpip', COALESCE(round(100.0*a.vpip_hands/NULLIF(a.hands,0),2),0),
    'pfr',  COALESCE(round(100.0*a.pfr_hands/NULLIF(a.hands,0),2),0),
    -- 3-bets per hand dealt. Not per opportunity: the facts table does not
    -- record whether this player faced an open they could have 3-bet.
    'three_bet', COALESCE(round(100.0*a.tb_hands/NULLIF(a.hands,0),2),0),
    'three_bet_basis', 'hands',
    'three_bets', a.tb_hands,
    'fold_to_three_bet', COALESCE(round(100.0*a.folded_tb/NULLIF(a.faced_tb,0),2),0),
    'faced_three_bets', a.faced_tb,
    'cbet', COALESCE(round(100.0*a.cb_hands/NULLIF(a.cb_opps,0),2),0),
    'cbet_opportunities', a.cb_opps,
    'net', round(a.net,2), 'fees', round(a.fees,2),
    'from', p_from, 'to', p_to, 'is_overall', p_from IS NULL AND p_to IS NULL
  ) INTO v_out FROM agg a CROSS JOIN vars;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_agent_payables(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_agent_payables(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_tournaments(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_tournaments(uuid, integer, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_member_statistics(uuid, uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_statistics(uuid, uuid, text, date, date) TO authenticated, service_role;

-- ── 4. roster summary ──
CREATE OR REPLACE FUNCTION public.ca_club_members_summary(p_club_id uuid)
 RETURNS jsonb
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
  v_viewer_role text := 'player';
  v_has_agent_scope boolean := false;
  v_has_staff_scope boolean := false;
  v_can_export boolean := false;
  v_out jsonb;
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT v_service AND v_actor IS NOT NULL THEN
    SELECT coalesce(p.is_admin, false)
      INTO v_platform_admin FROM public.profiles p WHERE p.id = v_actor;
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);
  END IF;

  IF NOT v_service AND NOT v_platform_admin AND NOT v_union_staff THEN
    SELECT cm.role
      INTO v_viewer_role
      FROM public.club_members cm
     WHERE cm.user_id = v_actor
       AND cm.club_id = ANY(v_scope)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY public.fn_club_role_rank(cm.role) DESC
     LIMIT 1;
    IF v_viewer_role IS NULL THEN
      RETURN NULL;
    END IF;
  ELSIF v_platform_admin OR v_union_staff OR v_service THEN
    v_viewer_role := 'owner';
  END IF;

  SELECT EXISTS (
           SELECT 1 FROM public.club_members cm
            WHERE cm.user_id = v_actor AND cm.club_id = ANY(v_scope)
              AND cm.role IN ('super_agent', 'agent', 'sub_agent')
              AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         ),
         EXISTS (
           SELECT 1 FROM public.club_members cm
            WHERE cm.user_id = v_actor AND cm.club_id = ANY(v_scope)
              AND cm.role IN ('owner', 'co_owner', 'admin')
              AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         )
    INTO v_has_agent_scope, v_has_staff_scope;

  v_can_export := v_service OR v_platform_admin OR v_union_staff OR EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = v_actor AND cm.club_id = p_club_id
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  );

  WITH base AS MATERIALIZED (
    -- THIS club, as ca_club_roster_rows counts it since 2026-09-01. The
    -- scope above still decides who the VIEWER is; it no longer decides
    -- what is counted.
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id, cm.role, public.fn_club_role_rank(cm.role) AS role_rank,
           cm.updated_at
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), seated AS MATERIALIZED (
    SELECT DISTINCT live.user_id
      FROM (
        SELECT ts.user_id
          FROM public.table_seats ts
          JOIN public.tables t ON t.id = ts.table_id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND ts.club_id = p_club_id
           AND t.status IN ('waiting', 'running')
        UNION
        SELECT ts.user_id
          FROM public.tables t
          JOIN public.table_seats ts ON ts.table_id = t.id
         WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
           AND t.club_id = p_club_id
           AND t.status IN ('waiting', 'running')
      ) live
  )
  SELECT jsonb_build_object(
    'viewer_role', coalesce(v_viewer_role, 'player'),
    'capabilities', jsonb_build_object(
      'can_view_financials', v_service OR v_platform_admin OR v_union_staff
                              OR v_has_staff_scope OR v_has_agent_scope,
      'can_export', v_can_export,
      'can_manage_members', v_service OR v_platform_admin OR v_union_staff OR v_has_staff_scope,
      'can_view_notes', v_service OR v_platform_admin OR v_union_staff
                        OR v_has_staff_scope OR v_has_agent_scope
    ),
    'counts', jsonb_build_object(
      'total', count(*),
      'online', count(*) FILTER (
        WHERE s.user_id IS NOT NULL
           OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')
      ),
      'seated', count(*) FILTER (WHERE s.user_id IS NOT NULL),
      'agents', count(*) FILTER (WHERE b.role IN ('super_agent', 'agent', 'sub_agent')),
      'admins', count(*) FILTER (WHERE b.role IN ('owner', 'co_owner', 'admin'))
    ),
    'data_version', max(b.updated_at),
    'page_size', 80
  ) INTO v_out
  FROM base b
  LEFT JOIN seated s ON s.user_id = b.user_id
  LEFT JOIN public.profiles pr ON pr.id = b.user_id;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_members_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members_summary(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_ca_agent_payables(uuid) IS
  'What a club owes each of its agents, from agent_commission_unsettled_rollup. Capped at 500 rows with totals over all. The superseded estimate came down 2026-09-04. Gated by fn_ca_can_manage_agents.';
COMMENT ON FUNCTION public.ca_club_members_summary(uuid) IS
  'Roster header: the viewer''s role and capabilities (resolved across the club''s scope) and the counts of THIS club''s members, seated, online, agents and admins - the same set ca_club_roster_rows lists.';

-- ─────────────────────────────────────────────────────────────────────────
--  Assertions
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE n integer; src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'fn_ca_agent_payables';
  IF src LIKE '%estimate%' THEN RAISE EXCEPTION 'fn_ca_agent_payables still carries the estimate'; END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'ca_club_tournaments';
  IF src LIKE '%completed_30d%' THEN RAISE EXCEPTION 'ca_club_tournaments still carries completed_30d'; END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'ca_club_member_statistics';
  IF src LIKE '%total_games%' THEN RAISE EXCEPTION 'ca_club_member_statistics still carries total_games'; END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'ca_club_members_summary';
  IF src NOT LIKE '%WHERE cm.club_id = p_club_id%' THEN RAISE EXCEPTION 'ca_club_members_summary does not count this club'; END IF;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('fn_ca_agent_payables', 'ca_club_tournaments', 'ca_club_member_statistics', 'ca_club_members_summary')
     AND p.prosecdef AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 gated definer functions, found %', n; END IF;
END $$;

COMMIT;
