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
  WITH asked AS MATERIALIZED (
    SELECT DISTINCT u AS uid FROM unnest(coalesce(p_user_ids, ARRAY[]::uuid[])) u WHERE u IS NOT NULL
  ), allowed AS MATERIALIZED (
    SELECT a.uid FROM asked a
     WHERE public.ca_club_roster_access(p_club_id, a.uid) IN ('staff', 'downline', 'service')
  ), cash AS MATERIALIZED (
    SELECT c.user_id uid,c.cash_net FROM public.ca_club_members_cash_window(
      p_club_id,ARRAY(SELECT a.uid FROM allowed a),v_from,
      CASE WHEN v_from IS NULL THEN NULL ELSE v_chicago_today+1 END) c
  ), mtt AS MATERIALIZED (
    SELECT a.uid,public.ca_club_member_tournament_money(
      p_club_id,a.uid,CASE WHEN v_from IS NULL THEN NULL ELSE v_start END,
      CASE WHEN v_period='today' THEN v_end ELSE NULL END) mtt_net FROM allowed a
  )
  SELECT c.uid,round(c.cash_net,2),round(m.mtt_net,2),round(c.cash_net+m.mtt_net,2)
  FROM cash c JOIN mtt m ON m.uid=c.uid;
END;
$function$
