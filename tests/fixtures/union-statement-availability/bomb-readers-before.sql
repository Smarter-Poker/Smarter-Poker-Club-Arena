CREATE OR REPLACE FUNCTION public.fn_club_bomb_pot_report(p_club_id uuid, p_days integer DEFAULT 30)
 RETURNS TABLE(table_id uuid, table_name text, trigger_reason text, board_count integer, variant text, hands bigint, avg_players numeric, avg_pot numeric, total_pot numeric, total_rake numeric, total_antes numeric, scoops bigint, splits bigint, unrecorded_hands bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid        uuid    := auth.uid();
  v_authorized boolean := false;
  v_days       integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_from       date;
  v_live_from  date;
  v_oldest     date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = v_uid)
    OR EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
        AND lower(cm.role) IN ('owner', 'co_owner', 'admin')
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  PERFORM public.fn_ca_bomb_pot_catchup(p_club_id, v_days);

  v_from := (now() - make_interval(days => v_days))::date;

  SELECT MIN(g)::date INTO v_live_from
    FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM public.ca_club_bomb_pot_complete c
                      WHERE c.club_id = p_club_id AND c.day = g::date);
  v_live_from := COALESCE(v_live_from, (now() AT TIME ZONE 'UTC')::date);

  -- THE FLOOR THIS MIGRATION ADDS. An unsealed day older than the oldest
  -- surviving bomb pot hand holds nothing to find, and the catchup will never
  -- seal it because sealing a pruned day would write zeroes over real history.
  -- Without this, a thirty-day window scanned a month of hand_history to
  -- discover that twenty-three of those days were empty.
  SELECT MIN(h.created_at)::date INTO v_oldest
    FROM public.hand_history h
   WHERE h.bomb_pot IS NOT NULL;
  IF v_oldest IS NULL THEN
    v_live_from := (now() AT TIME ZONE 'UTC')::date;
  ELSIF v_oldest > v_live_from THEN
    v_live_from := v_oldest;
  END IF;

  RETURN QUERY
  WITH ok_days AS MATERIALIZED (
    SELECT c.day FROM public.ca_club_bomb_pot_complete c
     WHERE c.club_id = p_club_id AND c.day >= v_from
  ), from_rollup AS (
    SELECT d.table_id, d.trigger_reason, d.board_count, d.variant,
           d.hands, d.seats_sum, d.pot_sum, d.rake_sum, d.ante_sum,
           d.scoops, d.splits, d.unrecorded
      FROM public.ca_club_bomb_pot_daily d
      JOIN ok_days o ON o.day = d.day
     WHERE d.club_id = p_club_id
  ), from_live AS (
    SELECT b.table_id, b.trigger_reason, b.board_count, b.variant,
           count(*)::bigint                                          AS hands,
           SUM(b.seats)::numeric                                     AS seats_sum,
           SUM(b.pot_size)                                           AS pot_sum,
           SUM(b.rake_amount)                                        AS rake_sum,
           SUM(b.ante_amount * b.seats)                              AS ante_sum,
           count(*) FILTER (WHERE u.distinct_winners = 1)::bigint    AS scoops,
           count(*) FILTER (WHERE u.distinct_winners > 1)::bigint    AS splits,
           count(*) FILTER (WHERE u.hand_history_id IS NULL)::bigint AS unrecorded
      FROM (
        SELECT h.id, h.table_id,
               h.bomb_pot ->> 'trigger_reason'                      AS trigger_reason,
               (h.bomb_pot ->> 'board_count')::int                  AS board_count,
               h.bomb_pot ->> 'variant'                             AS variant,
               COALESCE((h.bomb_pot ->> 'ante_amount')::numeric, 0) AS ante_amount,
               COALESCE(h.pot_size, 0)                              AS pot_size,
               COALESCE(h.rake_amount, 0)                           AS rake_amount,
               COALESCE(jsonb_array_length(h.players), 0)           AS seats
          FROM public.hand_history h
          WHERE h.table_id = ANY(ARRAY(SELECT t.id FROM public.tables t WHERE t.club_id = p_club_id))
           AND h.bomb_pot IS NOT NULL
           AND h.created_at >= v_live_from::timestamptz
           AND NOT EXISTS (SELECT 1 FROM ok_days o2
                            WHERE o2.day = (h.created_at AT TIME ZONE 'UTC')::date)
      ) b
      LEFT JOIN (
        SELECT a.hand_history_id, count(DISTINCT a.user_id) AS distinct_winners
          FROM public.bomb_pot_award_units a
         WHERE a.created_at >= v_live_from::timestamptz
         GROUP BY a.hand_history_id
      ) u ON u.hand_history_id = b.id
     GROUP BY b.table_id, b.trigger_reason, b.board_count, b.variant
  ), merged AS (
    SELECT * FROM from_rollup
    UNION ALL
    SELECT * FROM from_live
  ), totalled AS (
    SELECT m.table_id, m.trigger_reason, m.board_count, m.variant,
           SUM(m.hands)::bigint      AS hands,
           SUM(m.seats_sum)          AS seats_sum,
           SUM(m.pot_sum)            AS pot_sum,
           SUM(m.rake_sum)           AS rake_sum,
           SUM(m.ante_sum)           AS ante_sum,
           SUM(m.scoops)::bigint     AS scoops,
           SUM(m.splits)::bigint     AS splits,
           SUM(m.unrecorded)::bigint AS unrecorded
      FROM merged m
     GROUP BY m.table_id, m.trigger_reason, m.board_count, m.variant
  )
  SELECT tt.table_id,
         t.name,
         tt.trigger_reason,
         tt.board_count,
         tt.variant,
         tt.hands,
         round(tt.seats_sum / NULLIF(tt.hands, 0), 2),
         round(tt.pot_sum   / NULLIF(tt.hands, 0), 2),
         round(tt.pot_sum,  2),
         round(tt.rake_sum, 2),
         round(tt.ante_sum, 2),
         tt.scoops,
         tt.splits,
         tt.unrecorded
    FROM totalled tt
    LEFT JOIN public.tables t ON t.id = tt.table_id
   ORDER BY tt.hands DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_bomb_pot_catchup(p_club_id uuid, p_days integer DEFAULT 30)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_day  date;
  v_done integer := 0;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Only days the hands can still answer for. Reaching further back would
  -- write ZEROES over history that pruning removed, which is worse than the
  -- gap it would be papering over: the rollup exists to be believed.
  FOR v_day IN
    SELECT g::date
      FROM generate_series(
             GREATEST(
               (now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365)))::date,
               (SELECT MIN(h.created_at)::date FROM public.hand_history h
                 WHERE h.bomb_pot IS NOT NULL)
             ),
             (now() - interval '15 minutes')::date - 1,
             interval '1 day') g
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ca_club_bomb_pot_complete c
        WHERE c.club_id = p_club_id AND c.day = g::date)
     ORDER BY g DESC
     LIMIT 40
  LOOP
    PERFORM public.fn_ca_bomb_pot_rollup_day(p_club_id, v_day);
    v_done := v_done + 1;
  END LOOP;

  RETURN v_done;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_bomb_pot_report_v2(p_club_id uuid, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_window_start date := (now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365)))::date;
  v_window_end date := (now() AT TIME ZONE 'UTC')::date;
  v_rows jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.hands DESC), '[]'::jsonb)
    INTO v_rows
    FROM public.fn_club_bomb_pot_report(p_club_id, p_days) r;
  RETURN jsonb_build_object(
    'contract', 'fn_club_bomb_pot_report.v2',
    'contract_version', 2,
    'club_id', p_club_id,
    'requested_days', p_days,
    'window_days', v_days,
    'window_start', v_window_start,
    'window_end', v_window_end,
    'rows', v_rows,
    'generated_at', now()
  );
END;
$function$;
