-- Source candidate only: protected catalog execution and migration admission pending.
-- A presence deposit is a plan. Only the atomic transfer receipt proves arrival.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS cash_seat_move_receipts_destination_occupancy_idx
  ON public.cash_seat_move_receipts (destination_occupancy_id);

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_arrivals(p_table_id uuid, p_occupancy_ids uuid[])
RETURNS TABLE(move_id uuid, player_id uuid, from_table_id uuid, to_table_id uuid,
              source_occupancy_id uuid, destination_occupancy_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
  IF NOT coalesce(public.fn_caller_is_engine(), false) THEN
    RAISE EXCEPTION 'ENGINE_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_table_id IS NULL OR p_occupancy_ids IS NULL
     OR cardinality(p_occupancy_ids) > 64
     OR array_position(p_occupancy_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_SEAT_MOVE_ARRIVAL_SCOPE' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT r.move_id, r.player_id, r.from_table_id, r.to_table_id,
           r.source_occupancy_id, r.destination_occupancy_id
      FROM public.cash_seat_move_receipts r
      JOIN public.table_seats s
        ON s.occupancy_id = r.destination_occupancy_id
       AND s.user_id = r.player_id AND s.table_id = r.to_table_id
       AND s.left_at IS NULL
     WHERE r.to_table_id = p_table_id
       AND r.destination_occupancy_id = ANY(p_occupancy_ids);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cash_seat_move_arrivals(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_arrivals(uuid, uuid[]) TO service_role;
COMMIT;
