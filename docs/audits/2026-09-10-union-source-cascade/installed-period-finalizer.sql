-- Native fixture: exact tracked period finalizer and ACL, no production execution.
CREATE OR REPLACE FUNCTION public.fn_union_mark_period_settled(
  p_union_id uuid,
  p_from     timestamp with time zone,
  p_to       timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows int := 0;
BEGIN
  INSERT INTO settlement_periods (club_id, union_id, period_number, year,
                                  start_at, end_at, status, settled_at)
  SELECT uc.club_id, p_union_id,
         EXTRACT(week FROM p_from)::int, EXTRACT(isoyear FROM p_from)::int,
         p_from, p_to, 'settled', now()
    FROM union_clubs uc
   WHERE uc.union_id = p_union_id
  ON CONFLICT (club_id, union_id, start_at, end_at) DO UPDATE
     SET status     = CASE WHEN settlement_periods.status IN ('closed','disputed')
                           THEN settlement_periods.status ELSE 'settled' END,
         settled_at = COALESCE(settlement_periods.settled_at, now()),
         updated_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('periods_marked_settled', v_rows,
                            'period_start', p_from, 'period_end', p_to);
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_mark_period_settled(uuid, timestamp with time zone, timestamp with time zone)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_mark_period_settled(uuid, timestamp with time zone, timestamp with time zone)
  TO service_role;

