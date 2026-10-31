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
