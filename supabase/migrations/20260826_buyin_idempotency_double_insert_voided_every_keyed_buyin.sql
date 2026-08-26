-- 2026-08-26 — A KEYED BUY-IN DEBITED NOTHING, SEATED NOBODY, AND RAISED NOTHING.
--
-- WHAT WAS WRONG
--   `atomic_table_buyin` carried the idempotency guard TWICE. The first copy is
--   at the top of the function. A second, identical copy had been pasted inside
--   the NIT-GAME `DECLARE v_nit jsonb; BEGIN ... END;` block further down.
--
--   The guard is:
--       INSERT INTO transaction_idempotency_keys ... ON CONFLICT (key) DO NOTHING;
--       IF NOT FOUND THEN RETURN; END IF;
--
--   On a FIRST call with a non-null key, copy one inserts the row and continues.
--   Copy two then inserts THE SAME KEY AGAIN, conflicts, writes zero rows, sees
--   NOT FOUND, and RETURNs — from the whole function, because a RETURN inside a
--   nested block returns from the function.
--
--   The function is `RETURNS void`, so that early return is indistinguishable
--   from success. No chips were debited. No `table_seats` row was written. No
--   `wallet_transactions` row was written. No exception reached the client, so
--   `TablePage` held the optimistic seat and told the player they were in.
--
--   EVERY buy-in that supplied `p_idempotency_key` was a silent no-op.
--
-- EVIDENCE (read-only, taken before this migration)
--   `transaction_idempotency_keys` held exactly 2 rows for action
--   'atomic_table_buyin', both for user 47965354-0e56-43ef-931c-ddaab82af765,
--   1000 chips, at 12:50:35Z and 12:56:14Z on 2026-08-26 — the same player
--   trying twice, six minutes apart. Matching `wallet_transactions` rows in a
--   +/-30s window around each: ZERO and ZERO.
--
--   The other 14,632 buy-ins in the same 24 hours passed a NULL key (the
--   Hetzner engine seating horses) and were unaffected, which is why nothing
--   went red and no alarm fired.
--
-- THE FIX
--   Remove the second copy. Nothing else in the function changes: this file is
--   the deployed definition with that one block deleted.
--
-- ROLLBACK
--   Re-apply the previous definition by pasting the second guard back inside
--   the `DECLARE v_nit jsonb; BEGIN` block, immediately before the
--   `v_nit := public.fn_nit_check(...)` assignment. Doing so restores the bug;
--   there is no reason to.

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_no_rathole boolean;
  v_is_template boolean;
  v_vip_only boolean;
  v_is_vip boolean;
  v_staff boolean;
  v_last_stack numeric;
  v_rathole_floor numeric;
  v_max_players integer;
  v_seats_taken integer;
  v_new_balance NUMERIC;
  v_club_id UUID;
  v_union_id UUID;
  v_ban_id UUID;
  v_min_buy_in NUMERIC;
  v_max_buy_in NUMERIC;
  v_active_tables INT;
  v_seat_club UUID;
  v_max_tables CONSTANT INT := 6;
BEGIN
    -- THE ONLY IDEMPOTENCY GUARD IN THIS FUNCTION. Do not add a second one.
    -- A duplicate of this block lower down made every keyed buy-in a silent
    -- no-op from the moment stable keys started being sent (2026-08-26).
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO public.transaction_idempotency_keys (key, user_id, action, amount)
        VALUES (p_idempotency_key, p_user_id, 'atomic_table_buyin', p_amount) ON CONFLICT (key) DO NOTHING;
        IF NOT FOUND THEN
            RETURN;
        END IF;
    END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot buy in for another user';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in, COALESCE(t.max_players, 0),
         COALESCE(t.no_rathole, false), COALESCE(t.is_vip_only, false), COALESCE(t.is_template, false)
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in, v_max_players,
         v_no_rathole, v_vip_only, v_is_template
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id LIMIT 1;

  -- A template is a saved SHAPE, not a game. Nothing buys a seat at one,
  -- whatever happens to link to it (2026-08-25).
  IF v_is_template THEN
    RAISE EXCEPTION 'IS_TEMPLATE: this is a saved table template, not a live game';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid buy-in amount';
  END IF;
  IF v_min_buy_in IS NOT NULL AND v_min_buy_in > 0 AND p_amount < v_min_buy_in THEN
    RAISE EXCEPTION 'Buy-in below table minimum (min %)', v_min_buy_in;
  END IF;
  IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 AND p_amount > v_max_buy_in THEN
    RAISE EXCEPTION 'Buy-in above table maximum (max %)', v_max_buy_in;
  END IF;

  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id
       AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN
      RAISE EXCEPTION 'Banned from this club';
    END IF;
  END IF;

  -- VIP ONLY (added 2026-08-25)
  IF v_vip_only THEN
    SELECT COALESCE(p.is_vip, false)
           AND (p.vip_expires_at IS NULL OR p.vip_expires_at > now())
      INTO v_is_vip
      FROM profiles p WHERE p.id = p_user_id LIMIT 1;

    IF NOT COALESCE(v_is_vip, false) AND v_club_id IS NOT NULL THEN
      -- The host and their staff run the table; they are never locked out of it.
      SELECT EXISTS (
        SELECT 1 FROM club_members cm
         WHERE cm.club_id = v_club_id AND cm.user_id = p_user_id
           AND cm.role IN ('owner', 'admin', 'manager', 'agent')
      ) OR EXISTS (
        SELECT 1 FROM clubs c WHERE c.id = v_club_id AND c.owner_id = p_user_id
      ) INTO v_staff;
    END IF;

    IF NOT COALESCE(v_is_vip, false) AND NOT COALESCE(v_staff, false) THEN
      RAISE EXCEPTION 'VIP_ONLY: this table is open to VIP members only'
        USING HINT = 'VIP membership is required to take a seat at this table.';
    END IF;
  END IF;

  -- NIT GAME, CAREER VPIP (added 2026-08-25). Fails OPEN below the
  -- sample floor: a player with no history has a VPIP of 0/0, not 0.
  -- See fn_nit_check.
  DECLARE v_nit jsonb;
  BEGIN
    v_nit := public.fn_nit_check(p_table_id, p_user_id, NULL);
    IF (v_nit->>'ok')::boolean = false AND v_nit->>'reason' = 'career_vpip' THEN
      RAISE EXCEPTION 'NIT_GAME: this table needs a career VPIP of at least %, and yours is % over % hands',
        v_nit->>'required', v_nit->>'vpip', v_nit->>'hands'
        USING HINT = 'The host has set a minimum voluntarily-put-in-pot rate for this game.';
    END IF;
  END;

  IF EXISTS (SELECT 1 FROM table_seats
              WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  -- TABLE SIZE (added 2026-08-25)
  -- Serialise every buy-in AT THIS TABLE. The user-keyed lock above cannot
  -- stop two different players racing for one seat.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || p_table_id::text, 0));

  IF v_max_players > 0 AND p_seat_number > v_max_players THEN
    RAISE EXCEPTION 'TABLE_SIZE: seat % does not exist at this table (% max)',
      p_seat_number, v_max_players;
  END IF;

  IF v_max_players > 0 THEN
    SELECT COUNT(*) INTO v_seats_taken
      FROM table_seats
     WHERE table_id = p_table_id AND left_at IS NULL;
    IF v_seats_taken >= v_max_players THEN
      RAISE EXCEPTION 'TABLE_SIZE: table is full (% of % seats taken)',
        v_seats_taken, v_max_players;
    END IF;
  END IF;

  -- NO RATHOLE (added 2026-08-25)
  -- Come back with what you left with. Read from the departed seat row, which
  -- still carries the stack; capped at the table maximum so a player who won
  -- a big pot is not locked out of their own game.
  IF v_no_rathole THEN
    SELECT ts.stack INTO v_last_stack
      FROM table_seats ts
     WHERE ts.table_id = p_table_id
       AND ts.user_id = p_user_id
       AND ts.left_at IS NOT NULL
     ORDER BY ts.left_at DESC
     LIMIT 1;

    IF v_last_stack IS NOT NULL AND v_last_stack > 0 THEN
      v_rathole_floor := v_last_stack;
      IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 AND v_rathole_floor > v_max_buy_in THEN
        v_rathole_floor := v_max_buy_in;
      END IF;
      IF p_amount < v_rathole_floor THEN
        RAISE EXCEPTION
          'NO_RATHOLE: this table requires you to return with the % you left with', v_rathole_floor
          USING HINT = 'The host has switched ratholing off for this table.';
      END IF;
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_active_tables
    FROM table_seats ts JOIN tables t ON t.id = ts.table_id
   WHERE ts.user_id = p_user_id AND ts.left_at IS NULL
     AND t.tournament_id IS NULL AND t.status NOT IN ('closed','deleted');
  IF v_active_tables >= v_max_tables THEN
    RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at % cash tables (max %)', v_active_tables, v_max_tables;
  END IF;

  -- CLUB ARENA RULE: chips come from the club wallet. There is no global wallet.
  v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_club_id);
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this player at this table'
      USING HINT = 'The player must hold a membership in a club that belongs to this game''s union.';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for buy-in (club %)', v_seat_club;
  END IF;

  DELETE FROM table_seats
   WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy, club_id)
       VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy, v_seat_club);

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'buyin',
            'Cash game buy-in (club wallet)', p_table_id, v_new_balance);

  UPDATE tables
     SET current_players = (SELECT COUNT(*) FROM table_seats
                             WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;
END;
$function$;

-- POST-APPLY ASSERTIONS. These abort the migration if the fix did not take.
DO $$
DECLARE
  v_src text;
  v_guards int;
BEGIN
  SELECT prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: atomic_table_buyin does not exist after apply';
  END IF;

  -- Exactly one insert into the idempotency table.
  v_guards := (length(v_src) - length(replace(v_src, 'INTO public.transaction_idempotency_keys', ''))) 
              / length('INTO public.transaction_idempotency_keys');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION 'ASSERT FAILED: expected exactly 1 idempotency guard, found %', v_guards;
  END IF;

  -- The money path must still be present.
  IF position('UPDATE club_members' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: club_members debit missing from function body';
  END IF;
  IF position('INSERT INTO table_seats' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: table_seats insert missing from function body';
  END IF;
  IF position('fn_nit_check' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: nit check missing from function body';
  END IF;

  RAISE NOTICE 'atomic_table_buyin: 1 idempotency guard, money path intact.';
END $$;
