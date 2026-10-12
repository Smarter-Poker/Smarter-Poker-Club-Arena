CREATE OR REPLACE FUNCTION public.fn_ca_bomb_pot_rollup_day(p_club_id uuid, p_day date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows  integer := 0;
  v_hands bigint  := 0;
BEGIN
  IF p_club_id IS NULL OR p_day IS NULL THEN
    RETURN 0;
  END IF;

  -- A day is finished fifteen minutes after it ends, never before. See the
  -- header: bomb_pot_award_units can land a moment late and a sealed day is
  -- not recomputed.
  IF (p_day + 1)::timestamptz > now() - interval '15 minutes' THEN
    RETURN 0;
  END IF;

  DELETE FROM public.ca_club_bomb_pot_daily d
   WHERE d.club_id = p_club_id AND d.day = p_day;

  WITH bomb_hands AS (
    SELECT h.id,
           h.table_id,
           h.bomb_pot ->> 'trigger_reason'                       AS trigger_reason,
           (h.bomb_pot ->> 'board_count')::int                   AS board_count,
           h.bomb_pot ->> 'variant'                              AS variant,
           COALESCE((h.bomb_pot ->> 'ante_amount')::numeric, 0)  AS ante_amount,
           COALESCE(h.pot_size, 0)                               AS pot_size,
           COALESCE(h.rake_amount, 0)                            AS rake_amount,
           COALESCE(jsonb_array_length(h.players), 0)            AS seats
      FROM public.hand_history h
      JOIN public.tables t ON t.id = h.table_id
     WHERE t.club_id = p_club_id
       AND h.bomb_pot IS NOT NULL
       AND h.created_at >= p_day::timestamptz
       AND h.created_at <  (p_day + 1)::timestamptz
  ), per_hand_units AS (
    SELECT a.hand_history_id,
           count(DISTINCT a.user_id) AS distinct_winners
      FROM public.bomb_pot_award_units a
      JOIN bomb_hands b ON b.id = a.hand_history_id
     GROUP BY a.hand_history_id
  ), grouped AS (
    SELECT b.table_id, b.trigger_reason, b.board_count, b.variant,
           count(*)::bigint                                              AS hands,
           SUM(b.seats)::numeric                                         AS seats_sum,
           SUM(b.pot_size)                                               AS pot_sum,
           SUM(b.rake_amount)                                            AS rake_sum,
           SUM(b.ante_amount * b.seats)                                  AS ante_sum,
           count(*) FILTER (WHERE u.distinct_winners = 1)::bigint        AS scoops,
           count(*) FILTER (WHERE u.distinct_winners > 1)::bigint        AS splits,
           count(*) FILTER (WHERE u.hand_history_id IS NULL)::bigint     AS unrecorded
      FROM bomb_hands b
      LEFT JOIN per_hand_units u ON u.hand_history_id = b.id
     GROUP BY b.table_id, b.trigger_reason, b.board_count, b.variant
  )
  INSERT INTO public.ca_club_bomb_pot_daily
    (club_id, day, table_id, trigger_reason, board_count, variant,
     hands, seats_sum, pot_sum, rake_sum, ante_sum, scoops, splits, unrecorded)
  SELECT p_club_id, p_day, g.table_id, g.trigger_reason, g.board_count, g.variant,
         g.hands, g.seats_sum, g.pot_sum, g.rake_sum, g.ante_sum,
         g.scoops, g.splits, g.unrecorded
    FROM grouped g;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT COALESCE(SUM(d.hands), 0) INTO v_hands
    FROM public.ca_club_bomb_pot_daily d
   WHERE d.club_id = p_club_id AND d.day = p_day;

  -- The marker is written even when the day held no bomb pots. A day with
  -- none is a FACT, and without the marker it would be re-scanned live for
  -- ever and read as "not yet known" rather than "none".
  INSERT INTO public.ca_club_bomb_pot_complete (club_id, day, rows_written, hands_read, computed_at)
  VALUES (p_club_id, p_day, v_rows, v_hands, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_written = EXCLUDED.rows_written,
        hands_read   = EXCLUDED.hands_read,
        computed_at  = EXCLUDED.computed_at;

  RETURN v_rows;
END;
$function$

