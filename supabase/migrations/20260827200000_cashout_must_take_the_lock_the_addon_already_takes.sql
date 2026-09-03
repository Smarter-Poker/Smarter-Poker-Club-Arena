-- ═══════════════════════════════════════════════════════════════════════════
--  A LOCK ONLY WORKS IF BOTH SIDES TAKE IT
-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmed in production: 3 occurrences in 30 days, 205.68 chips destroyed,
-- most recently 2026-08-27 19:54:55Z — the day AFTER the fix that was meant to
-- close this. Every case reconstructs to the penny:
--
--   exit 21541  stack 200.00 = cash-out 62.90 + add-on 137.10
--   exit 15448  stack  55.00 = cash-out 12.32 + add-on  42.68
--   exit  7458  stack  45.00 = cash-out 19.10 + add-on  25.90
--
-- THE MECHANISM. `atomic_table_addon` opens a transaction, debits the club
-- wallet, runs `UPDATE table_seats SET stack = stack + n` and holds the row
-- lock. Before it commits, the engine's cash-out fires a PLAIN, UNLOCKED
-- `SELECT stack` (server/src/services/supabase/seats.ts). Under READ COMMITTED
-- that select does not wait on a writer, so it reads the PRE-add-on stack and
-- credits only that. The add-on then commits. The cash-out's later
-- `UPDATE ... left_at` finally takes the lock, and the BEFORE-UPDATE trigger
-- records the POST-add-on stack. Credited 62.90, seat closed holding 200.00.
--
-- WHY 2026-08-26 DID NOT FIX IT. That pass added, to `atomic_table_addon`:
--   (b) FOR UPDATE on the seat read "so this serialises with
--       atomic_table_cashout"
--   (c) a zero-row guard so a debit cannot stand alone if the seat vanished
-- Both are correct. Both are INERT, because the engine does not call
-- `atomic_table_cashout` — that function's only callers are client-side
-- (TableService, HydraService). The engine cashes out through `atomicCashout`
-- and `markSeatAsLeft`, which take NO lock at all. One side of a handshake is
-- not a handshake, and the bug recurred the next day.
--
-- THE FIX. Give the engine a cash-out that takes the SAME lock, so the two
-- orderings are both safe:
--   add-on first  -> cash-out blocks, then reads the stack INCLUDING the
--                    add-on, and refunds all of it;
--   cash-out first-> add-on blocks, then its UPDATE matches zero rows, guard
--                    (c) raises, and its debit rolls back. The player keeps
--                    the chips in their wallet instead of on a dead seat.
--
-- Everything the TypeScript had earned stays: the occupancy-scoped idempotency
-- key, the legacy-key transition guard, the 'Cash-out from table' description,
-- seat-club-first wallet resolution, and — most important — NOT vacating the
-- seat when the credit fails. Here that last one is free: one transaction, so
-- a failed credit rolls the seat back with it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── TWO CORRECTIONS MADE WHILE APPLYING THIS, both worth keeping in the record
--
-- 1. The first cut took the idempotency key as a PARAMETER. Unusable: the key
--    is `cashout:<seat.id>:<seat.joined_at>`, so a caller would have to read the
--    seat to build it, reintroducing the very unlocked pre-read this deletes.
--    The keys are derived from the row read UNDER THE LOCK instead.
--
-- 2. That derivation first used to_char(... '.US'), which PADS microseconds to
--    six digits. PostgREST TRIMS trailing zeros. Verified against real keys:
--        TypeScript wrote  2026-08-21T16:30:26.3+00:00
--        to_char produced  2026-08-21T16:30:26.300000+00:00   <- different key
--    A key that does not match is a key that does not dedupe, so a committed-
--    but-timed-out credit would be retried and PAY THE STACK TWICE - strictly
--    worse than the race being closed. to_json() is Postgres's own JSON
--    serialiser, the one PostgREST returns through, and reproduces the string
--    exactly. Checked against 6-, 5-, 3-, 1-digit and whole-second fractions:
--    to_json matched all five, to_char one. An assertion below re-checks the
--    format against 300 keys the TypeScript actually wrote.

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
  -- Inert for the service role (auth.uid() IS NULL), the only engine caller.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  -- ── THE LOCK ─────────────────────────────────────────────────────────────
  -- The entire point of this migration. Makes the read wait for any in-flight
  -- add-on on this seat, so the stack we refund is the stack the seat holds.
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

  -- Not an error: already left, or a retry landing after the winner.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'stack', 0, 'reason', 'no_active_seat');
  END IF;

  v_stack := COALESCE(v_seat.stack, 0);

  -- to_json, NOT to_char -- see correction 2 in the header.
  v_key := CASE
             WHEN v_seat.joined_at IS NOT NULL
               THEN 'cashout:' || v_seat.id || ':' || btrim(to_json(v_seat.joined_at)::text, '"')
             ELSE 'cashout:' || v_seat.id
           END;
  v_legacy := 'cashout:' || v_seat.id;

  IF v_stack > 0 THEN
    -- Paid under the pre-2026-08-20 unscoped key: skip the CREDIT, still
    -- vacate. Leaving the seat occupied double-counts the chips in
    -- fn_club_chip_circulation.
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

  -- We hold the lock, so this cannot legitimately be zero. If it is, we may
  -- have credited without closing the seat: raise and roll the credit back
  -- rather than let the two disagree.
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

-- Retire the 5-arg first cut so nothing can bind to it by accident.
DROP FUNCTION IF EXISTS public.atomic_seat_cashout_locked(uuid, uuid, integer, text, text);

REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer) TO service_role;

COMMENT ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer) IS
  'Engine cash-out. Reads the seat stack under FOR UPDATE so it serialises with '
  'atomic_table_addon, derives the occupancy-scoped idempotency key from the locked '
  'row, then credits and vacates in the SAME transaction. Service role only.';

-- ── Restitution ────────────────────────────────────────────────────────────
-- Applied separately as `return_chips_destroyed_by_the_cashout_addon_race`.
-- The 205.68 chips this destroyed, returned to the club wallets they were
-- debited from. The description format is the one fn_unaccounted_seat_exits
-- already excludes ('Correction: seat exit <id>%'), so a returned exit stops
-- being reported -- that mechanism exists for precisely this.
DO $$
DECLARE r record; v_club uuid; v_bal numeric; v_n integer := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (21541, '032b7ef6-ef40-4eb7-9a44-21605be733c8'::uuid, 137.10::numeric),
      (15448, 'e7925474-ad31-4cfb-826b-010039bcff3d'::uuid,  42.68::numeric),
      ( 7458, 'a916c222-1eb9-4e73-89ee-a92e289b80eb'::uuid,  25.90::numeric)
    ) AS t(exit_id, user_id, amount)
  LOOP
    IF EXISTS (SELECT 1 FROM wallet_transactions
                WHERE user_id = r.user_id
                  AND description LIKE 'Correction: seat exit ' || r.exit_id || '%')
    THEN CONTINUE; END IF;
    SELECT club_id INTO v_club FROM ca_seat_stack_exits WHERE id = r.exit_id;
    IF v_club IS NULL THEN v_club := public.fn_player_home_club(r.user_id, NULL); END IF;
    IF v_club IS NULL THEN CONTINUE; END IF;
    PERFORM public.fn_ensure_club_wallet(r.user_id, v_club);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance,0) + r.amount, updated_at = now()
     WHERE user_id = r.user_id AND club_id = v_club
     RETURNING chip_balance INTO v_bal;
    INSERT INTO wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    VALUES (r.user_id, 'PLAYER', 'credit', r.amount, 'cashout',
            'Correction: seat exit ' || r.exit_id || ' add-on lost to the cash-out race', v_bal);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'restitution: % exits corrected', v_n;
END $$;

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
DECLARE v_def text; v_n integer; v_bad integer;
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
  IF v_def ILIKE '%HH24:MI:SS.US%' THEN
    RAISE EXCEPTION 'key derivation uses to_char padding again - dedupe would break and double-credit';
  END IF;
  IF has_function_privilege('anon','public.atomic_seat_cashout_locked(uuid,uuid,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute atomic_seat_cashout_locked';
  END IF;

  -- The add-on's half of the handshake must still be there, or this lock is
  -- talking to nobody again - the exact 2026-08-26 failure, mirrored.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='atomic_table_addon';
  IF v_def NOT ILIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'atomic_table_addon lost its FOR UPDATE - the race is open again';
  END IF;

  -- Prove the key format against keys the TypeScript actually wrote.
  SELECT count(*) INTO v_bad
    FROM (SELECT id, joined_at FROM table_seats
           WHERE joined_at IS NOT NULL ORDER BY joined_at DESC LIMIT 300) s
    JOIN wallet_credit_idempotency k ON k.key LIKE 'cashout:'||s.id||':%'
   WHERE k.key <> 'cashout:'||s.id||':'||btrim(to_json(s.joined_at)::text,'"');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% existing cash-out keys do not round-trip through to_json', v_bad;
  END IF;
END $$;

-- ROLLBACK:
--   DROP FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer);
--   -- and revert seats.ts to the read/credit/vacate sequence (restores the race).
--   -- The restitution rows are deliberately NOT rolled back: the chips are real.
