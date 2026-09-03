-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827204232; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- SECOND CORRECTION, and the one that would have cost money.
--
-- The key is `cashout:<seat.id>:<seat.joined_at>` where the TypeScript
-- interpolated the timestamp string PostgREST handed it. I reproduced that in
-- SQL with to_char(... '.US'), which PADS microseconds to six digits. PostgREST
-- TRIMS trailing zeros. Verified against real keys:
--
--   TypeScript wrote   2026-08-27T19:26:55.16018+00:00
--   to_char produced   2026-08-27T19:26:55.160180+00:00   <- different key
--   TypeScript wrote   2026-08-21T16:30:26.3+00:00
--   to_char produced   2026-08-21T16:30:26.300000+00:00   <- different key
--
-- A key that does not match is a key that does not dedupe. A committed-but-
-- timed-out credit would be retried under the new format, miss the existing
-- row, and PAY THE STACK A SECOND TIME -- strictly worse than the race this
-- migration set out to close.
--
-- to_json(timestamptz) is Postgres's own JSON serialiser, the same one
-- PostgREST returns through, so it reproduces the string exactly. Checked
-- against five real shapes (6-digit, 5-digit, 3-digit, 1-digit and whole-second
-- fractions): to_json matched all five, to_char matched one.

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

  -- to_json, NOT to_char. See the header: to_char pads microseconds and breaks
  -- dedupe against every key the TypeScript already wrote.
  v_key := CASE
             WHEN v_seat.joined_at IS NOT NULL
               THEN 'cashout:' || v_seat.id || ':' || btrim(to_json(v_seat.joined_at)::text, '"')
             ELSE 'cashout:' || v_seat.id
           END;
  v_legacy := 'cashout:' || v_seat.id;

  IF v_stack > 0 THEN
    IF EXISTS (SELECT 1 FROM wallet_credit_idempotency WHERE key = v_legacy) THEN
      v_credited := false;
    ELSE
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

REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer) TO service_role;

DO $$
DECLARE v_def text; v_bad integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='atomic_seat_cashout_locked';

  IF v_def NOT ILIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'lost FOR UPDATE - it is the bug it replaces';
  END IF;
  -- The padding bug must not come back.
  IF v_def ILIKE '%HH24:MI:SS.US%' THEN
    RAISE EXCEPTION 'key derivation uses to_char padding again - dedupe would break and double-credit';
  END IF;
  IF v_def NOT ILIKE '%to_json(v_seat.joined_at)%' THEN
    RAISE EXCEPTION 'key derivation no longer uses to_json - it will not match PostgREST';
  END IF;

  -- Prove the format against keys the TypeScript actually wrote, rather than
  -- trusting the reasoning above.
  SELECT count(*) INTO v_bad
    FROM (SELECT id, joined_at FROM table_seats
           WHERE joined_at IS NOT NULL ORDER BY joined_at DESC LIMIT 300) s
    JOIN wallet_credit_idempotency k ON k.key LIKE 'cashout:'||s.id||':%'
   WHERE k.key <> 'cashout:'||s.id||':'||btrim(to_json(s.joined_at)::text,'"');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% existing cash-out keys do not round-trip through to_json', v_bad;
  END IF;
END $$;
