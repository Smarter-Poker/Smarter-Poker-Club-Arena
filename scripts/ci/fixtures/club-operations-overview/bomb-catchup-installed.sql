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
$function$
;
