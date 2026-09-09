CREATE OR REPLACE FUNCTION public.atomic_table_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_res jsonb;
BEGIN
  /* CHIP STANDARD C1 (2026-09-02): one cash-out path. This function used to
     carry its own unkeyed copy of the credit (a direct club_members write plus
     its own wallet_transactions row), so a retry of a committed-but-unacknowledged call
     credited twice. atomic_seat_cashout_locked keys the credit per seat
     occupancy (cashout:<seat id>:<joined_at>), locks the seat, closes it, and
     treats a tournament stack as play chips (no credit) - the same three
     rules this body had, minus the second copy of the money. The caller
     guard stays here so the error text is unchanged for callers. */
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);

  v_res := public.atomic_seat_cashout_locked(p_user_id, p_table_id, p_seat_number);

  IF COALESCE(v_res->>'reason', '') = 'no_active_seat' THEN
    RAISE EXCEPTION 'Active seat not found for cash-out';
  END IF;

  RETURN COALESCE((v_res->>'stack')::numeric, 0);
END;
$function$
;
