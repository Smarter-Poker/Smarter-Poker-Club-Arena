-- Lightning expiry must not race a paid rebuy or a funded replacement stack.
-- Additive, engine-only wrapper: the original occupancy cashout still owns
-- receipts, financial writes, Lightning hand guards and session/seat closure.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE FUNCTION public.fn_cashout_unfunded_seat_occupancy(
  p_user_id uuid, p_table_id uuid, p_seat_number integer,
  p_occupancy_id uuid, p_leave_mode text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, pg_temp
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_stack numeric;
BEGIN
  IF NOT coalesce(public.fn_caller_is_engine(), false) THEN
    RAISE EXCEPTION 'Engine authority required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_seat_number IS NULL
     OR p_occupancy_id IS NULL OR p_leave_mode IS DISTINCT FROM 'forced' THEN
    RAISE EXCEPTION 'BUST_CASHOUT_SCOPE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- Same admission lock and order as the canonical occupancy cashout/buy-in.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.seat_cashout_receipts WHERE occupancy_id = p_occupancy_id) THEN
    -- Delegate replay, including its original actor/table/seat scope checks.
    RETURN public.fn_cashout_seat_occupancy(
      p_user_id, p_table_id, p_seat_number, p_occupancy_id, p_leave_mode);
  END IF;

  -- This path is cash-only. Preserve the canonical Diamond table -> wallet
  -- -> seat order before taking the zero-stack predicate's seat lock.
  IF NOT EXISTS (SELECT 1 FROM public.tables WHERE id=p_table_id AND tournament_id IS NULL) THEN
    RAISE EXCEPTION 'BUST_CASH_TABLE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
              WHERE t.id=p_table_id AND c.asset='diamonds') THEN
    PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;
    PERFORM 1 FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  END IF;

  SELECT stack INTO v_stack FROM public.table_seats
   WHERE user_id = p_user_id AND table_id = p_table_id
     AND seat_number = p_seat_number AND occupancy_id = p_occupancy_id
     AND left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_STALE_OCCUPANCY' USING ERRCODE = '22023';
  END IF;
  IF v_stack IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'BUST_REBUY_FUNDED' USING ERRCODE = '55000';
  END IF;
  -- Rebuy and delivery serialize on the same seat row. A payment committed
  -- before this lock is visible here; one arriving afterward cannot debit
  -- against the closed seat. No pending obligation is consumed or refunded.
  IF EXISTS (SELECT 1 FROM public.table_pending_addons
              WHERE table_id = p_table_id AND user_id = p_user_id AND resolved_at IS NULL) THEN
    RAISE EXCEPTION 'BUST_REBUY_PENDING' USING ERRCODE = '55000';
  END IF;

  RETURN public.fn_cashout_seat_occupancy(
    p_user_id, p_table_id, p_seat_number, p_occupancy_id, p_leave_mode);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cashout_unfunded_seat_occupancy(uuid,uuid,integer,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cashout_unfunded_seat_occupancy(uuid,uuid,integer,uuid,text)
  TO service_role, postgres;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
VALUES ('fn_cashout_unfunded_seat_occupancy','approved',
  'Engine-only Lightning bust precondition under the occupancy seat lock; delegates all closure and immutable receipt replay to fn_cashout_seat_occupancy; never refunds or mutates a paid rebuy.')
ON CONFLICT (proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
COMMIT;
