-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827203656; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(
  p_user_id        uuid,
  p_table_id       uuid,
  p_seat_number    integer DEFAULT NULL,
  p_idempotency_key text   DEFAULT NULL,
  p_legacy_key     text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_seat        record;
  v_stack       numeric;
  v_credited    boolean := false;
  v_seat_rows   integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  -- THE LOCK: makes this read wait for any in-flight add-on on the same seat.
  IF p_seat_number IS NOT NULL THEN
    SELECT id, stack, joined_at, seat_number INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id
       AND seat_number = p_seat_number AND left_at IS NULL
     FOR UPDATE;
  ELSE
    SELECT id, stack, joined_at, seat_number INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     ORDER BY joined_at DESC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'stack', 0, 'reason', 'no_active_seat');
  END IF;

  v_stack := COALESCE(v_seat.stack, 0);

  IF v_stack > 0 THEN
    IF p_legacy_key IS NOT NULL
       AND EXISTS (SELECT 1 FROM wallet_credit_idempotency WHERE key = p_legacy_key)
    THEN
      v_credited := false;
    ELSE
      PERFORM public.atomic_credit_wallet_and_log(
        p_user_id, v_stack, 'cashout', 'Cash-out from table',
        p_table_id, NULL, NULL, p_idempotency_key
      );
      v_credited := true;
    END IF;
  END IF;

  UPDATE table_seats
     SET left_at = NOW(), leave_pending = false
   WHERE table_id = p_table_id AND user_id = p_user_id
     AND seat_number = v_seat.seat_number AND left_at IS NULL;
  GET DIAGNOSTICS v_seat_rows = ROW_COUNT;

  IF v_seat_rows = 0 THEN
    RAISE EXCEPTION
      'Cash-out could not vacate the locked seat (table %, player %, seat %)',
      p_table_id, p_user_id, v_seat.seat_number;
  END IF;

  UPDATE tables
     SET current_players = (
       SELECT count(*) FROM table_seats
        WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;

  RETURN jsonb_build_object(
    'ok', true, 'stack', v_stack, 'credited', v_credited,
    'seat_number', v_seat.seat_number);
END;
$$;

REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer, text, text) TO service_role;

COMMENT ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer, text, text) IS
  'Engine cash-out. Reads the seat stack under FOR UPDATE so it serialises with atomic_table_addon, then credits and vacates in the SAME transaction. Replaces the three-round-trip read/credit/vacate in server/src/services/supabase/seats.ts that destroyed an add-on landing in the gap. Service role only.';

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='atomic_seat_cashout_locked';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'atomic_seat_cashout_locked was not created';
  END IF;
  IF v_def NOT ILIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'atomic_seat_cashout_locked does not take FOR UPDATE - it is the bug it replaces';
  END IF;
  IF has_function_privilege('anon',
       'public.atomic_seat_cashout_locked(uuid,uuid,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute atomic_seat_cashout_locked';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='atomic_table_addon';
  IF v_def NOT ILIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'atomic_table_addon lost its FOR UPDATE - the race is open again';
  END IF;
END $$;
