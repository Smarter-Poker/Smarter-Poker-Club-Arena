-- Today is the Chicago calendar day, not a rolling 24-hour window.
-- Only Today changes: existing UTC week/month and lifetime accounting stay intact.
-- Preserve funded-club attribution, launch accounting cutoffs, and RPC permissions.
-- No wallet, ledger, facts, retention, or engine writes.
-- @live-proof: to_regprocedure('public.ca_club_member_chicago_today_cash(uuid,uuid,timestamptz)') IS NOT NULL
-- @live-proof: position('v_chicago_today' IN pg_get_functiondef('public.ca_club_member_win_loss(uuid,uuid)'::regprocedure)) > 0
-- @live-proof: position('ca_club_member_chicago_today_cash' IN pg_get_functiondef('public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure)) > 0
-- Read only the partial UTC-day edges, never a member's tournament history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_hand_facts_cash_member_time_idx
  ON public.ca_hand_facts (user_id, played_at) WHERE tournament_id IS NULL;

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.ca_hand_facts_cash_member_time_idx'::regclass AND indisvalid) THEN
    RAISE EXCEPTION 'Chicago Today cash index is invalid';
  END IF;
  IF md5(pg_get_functiondef('public.ca_club_member_win_loss(uuid,uuid)'::regprocedure))
       IS DISTINCT FROM '087b23df51da519414c102c7dbcadb55'
     OR md5(pg_get_functiondef('public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure))
       IS DISTINCT FROM '407a78c4bac48e4fe71a02884fd3b911' THEN
    RAISE EXCEPTION 'Chicago Today reader preimage changed';
  END IF;
END $guard$;

CREATE FUNCTION public.ca_club_member_chicago_today_cash(
  p_club_id uuid, p_user_id uuid, p_at timestamptz DEFAULT now()
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH day AS (
    SELECT (p_at AT TIME ZONE 'America/Chicago')::date AS local_day
  ), bounds AS (
    SELECT local_day,
      local_day::timestamp AT TIME ZONE 'UTC' AS utc_start,
      local_day::timestamp AT TIME ZONE 'America/Chicago' AS chicago_start,
      (local_day + 1)::timestamp AT TIME ZONE 'America/Chicago' AS chicago_end,
      (local_day + 2)::timestamp AT TIME ZONE 'UTC' AS utc_end
    FROM day
  )
  -- Two existing UTC buckets cover the Chicago day. Remove only their edges.
  SELECT (SELECT coalesce(sum(d.net), 0)
            FROM public.ca_member_record_daily_facts(p_club_id,p_user_id,b.local_day,b.local_day+1) d
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
          ) edge)
    FROM bounds b;
$function$;
REVOKE ALL ON FUNCTION public.ca_club_member_chicago_today_cash(uuid,uuid,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ca_club_member_win_loss(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_chicago_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_start timestamptz := v_chicago_today::timestamp AT TIME ZONE 'America/Chicago';
  v_end timestamptz := (v_chicago_today + 1)::timestamp AT TIME ZONE 'America/Chicago';
  v_week date := date_trunc('week', v_today)::date;
  v_month date := date_trunc('month', v_today)::date;
  v_earliest date;
  v_cash_today numeric; v_cash_week numeric; v_cash_month numeric; v_cash_all numeric;
  v_mtt_today numeric; v_mtt_week numeric; v_mtt_month numeric; v_mtt_all numeric;
BEGIN
  IF v_access IS NULL OR v_access NOT IN ('staff', 'downline', 'service') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  -- A week that started last month reaches back past the 1st.
  v_earliest := least(v_week, v_month);

  SELECT coalesce(sum(f.net) FILTER (WHERE f.played_on = v_today), 0),
         coalesce(sum(f.net) FILTER (WHERE f.played_on >= v_week), 0),
         coalesce(sum(f.net) FILTER (WHERE f.played_on >= v_month), 0)
    INTO v_cash_today, v_cash_week, v_cash_month
    FROM public.ca_member_record_daily_facts(p_club_id,p_user_id,v_earliest,v_today) f
   WHERE f.club_id = p_club_id AND f.user_id = p_user_id
     AND NOT f.is_mtt
     AND f.played_on >= v_earliest AND f.played_on <= v_today;

  SELECT coalesce(sum(t.net) FILTER(WHERE NOT t.is_mtt), 0) INTO v_cash_all
    FROM (SELECT 1) anchor
    LEFT JOIN public.ca_member_record_daily_facts(p_club_id,p_user_id,NULL,NULL) t
      ON t.club_id = p_club_id AND t.user_id = p_user_id;

  -- UTC daily aggregates cannot split the first/last partial UTC day.
  v_cash_today := public.ca_club_member_chicago_today_cash(p_club_id, p_user_id);

  v_mtt_today := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_start, v_end);
  v_mtt_week := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_week::timestamp AT TIME ZONE 'UTC', NULL);
  v_mtt_month := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_month::timestamp AT TIME ZONE 'UTC', NULL);
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
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_from date;
  v_chicago_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_start timestamptz := v_chicago_today::timestamp AT TIME ZONE 'America/Chicago';
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

  v_from := CASE v_period
    WHEN 'today' THEN v_today
    WHEN 'week' THEN date_trunc('week', v_today)::date
    WHEN 'month' THEN date_trunc('month', v_today)::date
    ELSE NULL END;

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
             (SELECT coalesce(sum(f.net), 0) FROM public.ca_member_record_daily_facts(p_club_id,al.uid,v_from,v_today) f
               WHERE f.club_id = p_club_id AND f.user_id = al.uid AND NOT f.is_mtt
                 AND f.played_on >= v_from AND f.played_on <= v_today)
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
        CASE WHEN v_period = 'today' THEN v_start
             WHEN v_from IS NULL THEN NULL ELSE v_from::timestamp AT TIME ZONE 'UTC' END,
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
