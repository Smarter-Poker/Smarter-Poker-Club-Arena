-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827203821; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- CORRECTION to atomic_seat_cashout_locked, same day.
--
-- The first cut took the idempotency key as a PARAMETER. That is unusable: the
-- key is `cashout:<seat.id>:<seat.joined_at>`, so a caller would have to read
-- the seat to build it -- reintroducing exactly the unlocked pre-read this
-- function exists to delete, and leaving a window where the caller's seat id
-- and the locked row could disagree.
--
-- The keys are derived from the row we read UNDER THE LOCK instead. Same format
-- as seats.ts produced (`cashoutKey` / the legacy `cashout:<id>`), so keys
-- already written by either TypeScript path still dedupe against these.

CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(
  p_user_id     uuid,
  p_table_id    uuid,
  p_seat_number integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_seat      record;
  v_stack     numeric;
  v_key       text;
  v_legacy    text;
  v_credited  boolean := false;
  v_seat_rows integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  -- THE LOCK. Waits for any in-flight add-on on this seat, so the stack we
  -- refund is the stack the seat actually holds.
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

  -- Occupancy-scoped, matching seats.ts `cashoutKey` byte for byte. table_seats
  -- rows are REUSED across occupants by the tournament balancer, so a key of
  -- just <seat.id> would let the first occupant's cash-out poison the seat for
  -- everyone after them.
  v_key := CASE
             WHEN v_seat.joined_at IS NOT NULL
               THEN 'cashout:' || v_seat.id || ':' ||
                    to_char(v_seat.joined_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')
             ELSE 'cashout:' || v_seat.id
           END;
  v_legacy := 'cashout:' || v_seat.id;

  IF v_stack > 0 THEN
    -- Paid under the old key format: skip the CREDIT, still vacate. Leaving the
    -- seat occupied would double-count the chips in fn_club_chip_circulation.
    IF EXISTS (SELECT 1 FROM wallet_credit_idempotency WHERE key = v_legacy) THEN
      v_credited := false;
    ELSE
      -- Raises on an unresolvable club wallet, rolling back this whole
      -- transaction: seat intact, stack preserved, retryable.
      PERFORM public.atomic_credit_wallet_and_log(
        p_user_id, v_stack, 'cashout', 'Cash-out from table',
        p_table_id, NULL, NULL, v_key
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
    'seat_number', v_seat.seat_number, 'idempotency_key', v_key);
END;
$$;

-- Retire the 5-arg first cut so no caller can pick it up by accident.
DROP FUNCTION IF EXISTS public.atomic_seat_cashout_locked(uuid, uuid, integer, text, text);

REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer) TO service_role;

COMMENT ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer) IS
  'Engine cash-out. Reads the seat stack under FOR UPDATE so it serialises with atomic_table_addon, derives the occupancy-scoped idempotency key from the locked row, then credits and vacates in the SAME transaction. Service role only.';

DO $$
DECLARE v_def text; v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='atomic_seat_cashout_locked';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 atomic_seat_cashout_locked overload, found %', v_n;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='atomic_seat_cashout_locked';
  IF v_def NOT ILIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'atomic_seat_cashout_locked does not take FOR UPDATE - it is the bug it replaces';
  END IF;
  IF has_function_privilege('anon','public.atomic_seat_cashout_locked(uuid,uuid,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute atomic_seat_cashout_locked';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='atomic_table_addon';
  IF v_def NOT ILIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'atomic_table_addon lost its FOR UPDATE - the race is open again';
  END IF;
END $$;
