-- 20261026011138_week_and_month_win_loss_reset_at_chicago_midnight.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-25, on the member Win / Loss card: "NO THIS WEEK AND MONTH NEEDS
-- TO BE DONE AT 12AM CHICAGO TIME AS WELL. NOT UTC."
--
-- 20261023213635 moved Today to the Chicago calendar day and deliberately left
-- This Week and This Month on UTC ranges. Both now use Chicago calendar
-- boundaries too: This Week starts Monday 12:00 AM America/Chicago and This
-- Month starts on the 1st at 12:00 AM America/Chicago (DST aware). Overall is
-- unchanged. Both readers change together, the player record
-- (ca_club_member_win_loss) and the member list (ca_club_members_win_loss),
-- so the two can never disagree.
--
-- Cash uses one new internal helper, ca_club_member_chicago_cash, that sums the
-- existing UTC daily facts covering the Chicago range and removes only the two
-- partial UTC-day edges from ca_hand_facts - the same method Today already uses,
-- over the same (user_id, played_at) index. Tournament money passes Chicago
-- timestamps to the existing ca_club_member_tournament_money.
--
-- Read-only reporting. No wallet, ledger, facts, retention or engine writes.
-- Funded-club attribution, launch accounting cutoffs and RPC permissions are
-- preserved; the helper is not callable by anon or authenticated.
--
-- @live-proof: to_regprocedure('public.ca_club_member_chicago_cash(uuid,uuid,date,date)') IS NOT NULL
-- @live-proof: position('ca_club_member_chicago_cash' IN pg_get_functiondef('public.ca_club_member_win_loss(uuid,uuid)'::regprocedure)) > 0
-- @live-proof: position('ca_club_member_chicago_cash' IN pg_get_functiondef('public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure)) > 0

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.ca_club_member_win_loss(uuid,uuid)'::regprocedure))
       IS DISTINCT FROM 'bdd3616a834125b6a2324ba5d0e0a6f8'
     OR md5(pg_get_functiondef('public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure))
       IS DISTINCT FROM '8f98d33db1a501afca0eeb3ee95f6b3f' THEN
    RAISE EXCEPTION 'Chicago week and month reader preimage changed';
  END IF;
END $guard$;

-- Cash net for the Chicago calendar days p_from .. p_to - 1, that is
-- [p_from 12:00 AM Chicago, p_to 12:00 AM Chicago).
CREATE FUNCTION public.ca_club_member_chicago_cash(
  p_club_id uuid, p_user_id uuid, p_from date, p_to date
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH bounds AS (
    SELECT p_from::timestamp AT TIME ZONE 'UTC' AS utc_start,
      p_from::timestamp AT TIME ZONE 'America/Chicago' AS chicago_start,
      p_to::timestamp AT TIME ZONE 'America/Chicago' AS chicago_end,
      (p_to + 1)::timestamp AT TIME ZONE 'UTC' AS utc_end
  )
  -- UTC buckets p_from .. p_to cover the Chicago range. Remove only their edges.
  SELECT CASE WHEN p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN 0::numeric ELSE
         (SELECT coalesce(sum(d.net), 0)
            FROM public.ca_member_record_daily_facts(p_club_id,p_user_id,p_from,p_to) d
           WHERE NOT d.is_mtt)
       - (SELECT coalesce(sum(edge.net), 0) FROM (
            SELECT f.net FROM public.ca_hand_facts f
             WHERE f.user_id=p_user_id AND f.tournament_id IS NULL
               AND f.played_at >= b.utc_start AND f.played_at < b.chicago_start
               AND public.fn_member_record_fact_club(f)=p_club_id
               AND public.fn_ca_launch_accounting_accepts(p_club_id,f.played_at)
            UNION ALL
            SELECT f.net FROM public.ca_hand_facts f
             WHERE f.user_id=p_user_id AND f.tournament_id IS NULL
               AND f.played_at >= b.chicago_end AND f.played_at < b.utc_end
               AND public.fn_member_record_fact_club(f)=p_club_id
               AND public.fn_ca_launch_accounting_accepts(p_club_id,f.played_at)
          ) edge) END
    FROM bounds b;
$function$;
REVOKE ALL ON FUNCTION public.ca_club_member_chicago_cash(uuid,uuid,date,date)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ca_club_member_win_loss(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_chicago_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_start timestamptz := v_chicago_today::timestamp AT TIME ZONE 'America/Chicago';
  v_end timestamptz := (v_chicago_today + 1)::timestamp AT TIME ZONE 'America/Chicago';
  -- Week (Monday) and month begin at 12:00 AM Chicago, like Today.
  v_week date := date_trunc('week', v_chicago_today::timestamp)::date;
  v_month date := date_trunc('month', v_chicago_today::timestamp)::date;
  v_cash_today numeric; v_cash_week numeric; v_cash_month numeric; v_cash_all numeric;
  v_mtt_today numeric; v_mtt_week numeric; v_mtt_month numeric; v_mtt_all numeric;
BEGIN
  IF v_access IS NULL OR v_access NOT IN ('staff', 'downline', 'service') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  SELECT coalesce(sum(t.net) FILTER(WHERE NOT t.is_mtt), 0) INTO v_cash_all
    FROM (SELECT 1) anchor
    LEFT JOIN public.ca_member_record_daily_facts(p_club_id,p_user_id,NULL,NULL) t
      ON t.club_id = p_club_id AND t.user_id = p_user_id;

  v_cash_today := public.ca_club_member_chicago_today_cash(p_club_id, p_user_id);
  v_cash_week := public.ca_club_member_chicago_cash(p_club_id, p_user_id, v_week, v_chicago_today + 1);
  v_cash_month := public.ca_club_member_chicago_cash(p_club_id, p_user_id, v_month, v_chicago_today + 1);

  v_mtt_today := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_start, v_end);
  v_mtt_week := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_week::timestamp AT TIME ZONE 'America/Chicago', NULL);
  v_mtt_month := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_month::timestamp AT TIME ZONE 'America/Chicago', NULL);
  v_mtt_all := public.ca_club_member_tournament_money(p_club_id, p_user_id, NULL, NULL);

  RETURN jsonb_build_object(
    'as_of', v_chicago_today,
    'week_from', v_week,
    'month_from', v_month,
    'today', jsonb_build_object('cash', round(v_cash_today, 2), 'mtt', round(v_mtt_today, 2),
                                'net', round(v_cash_today + v_mtt_today, 2)),
    'week', jsonb_build_object('cash', round(v_cash_week, 2), 'mtt', round(v_mtt_week, 2),
                               'net', round(v_cash_week + v_mtt_week, 2)),
    'month', jsonb_build_object('cash', round(v_cash_month, 2), 'mtt', round(v_mtt_month, 2),
                                'net', round(v_cash_month + v_mtt_month, 2)),
    'overall', jsonb_build_object('cash', round(v_cash_all, 2), 'mtt', round(v_mtt_all, 2),
                                  'net', round(v_cash_all + v_mtt_all, 2))
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ca_club_members_win_loss(p_club_id uuid, p_user_ids uuid[], p_period text DEFAULT 'overall'::text)
 RETURNS TABLE(user_id uuid, cash numeric, mtt numeric, net numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period text := lower(btrim(coalesce(p_period, 'overall')));
  v_chicago_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_from date;
  v_start timestamptz;
  v_end timestamptz := (v_chicago_today + 1)::timestamp AT TIME ZONE 'America/Chicago';
BEGIN
  IF v_period NOT IN ('today', 'week', 'month', 'overall') THEN
    RAISE EXCEPTION 'Invalid win loss period' USING ERRCODE = '22023';
  END IF;
  IF coalesce(cardinality(p_user_ids), 0) > 100 THEN
    RAISE EXCEPTION 'At most 100 members per call' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  -- Every period except Overall begins at 12:00 AM Chicago.
  v_from := CASE v_period
    WHEN 'today' THEN v_chicago_today
    WHEN 'week' THEN date_trunc('week', v_chicago_today::timestamp)::date
    WHEN 'month' THEN date_trunc('month', v_chicago_today::timestamp)::date
    ELSE NULL END;
  v_start := v_from::timestamp AT TIME ZONE 'America/Chicago';

  RETURN QUERY
  WITH asked AS (
    SELECT DISTINCT u AS uid FROM unnest(coalesce(p_user_ids, ARRAY[]::uuid[])) u WHERE u IS NOT NULL
  ), allowed AS (
    SELECT a.uid FROM asked a
     WHERE public.ca_club_roster_access(p_club_id, a.uid) IN ('staff', 'downline', 'service')
  ), cash AS (
    SELECT al.uid,
           CASE WHEN v_period = 'today' THEN
             public.ca_club_member_chicago_today_cash(p_club_id, al.uid)
           WHEN v_from IS NULL THEN
             (SELECT coalesce(sum(t.net) FILTER(WHERE NOT t.is_mtt), 0) FROM (SELECT 1) anchor
                LEFT JOIN public.ca_member_record_daily_facts(p_club_id,al.uid,NULL,NULL) t
                  ON t.club_id = p_club_id AND t.user_id = al.uid)
           ELSE
             public.ca_club_member_chicago_cash(p_club_id, al.uid, v_from, v_chicago_today + 1)
           END AS cash_net
      FROM allowed al
  )
  SELECT c.uid,
         round(c.cash_net, 2),
         round(m.mtt_net, 2),
         round(c.cash_net + m.mtt_net, 2)
    FROM cash c
    CROSS JOIN LATERAL (
      SELECT public.ca_club_member_tournament_money(
        p_club_id, c.uid,
        CASE WHEN v_from IS NULL THEN NULL ELSE v_start END,
        CASE WHEN v_period = 'today' THEN v_end ELSE NULL END) AS mtt_net
    ) m;
END;
$function$
;

REVOKE ALL ON FUNCTION public.ca_club_member_win_loss(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_win_loss(uuid,uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.ca_club_members_win_loss(uuid,uuid[],text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members_win_loss(uuid,uuid[],text) TO authenticated,service_role;

COMMIT;
