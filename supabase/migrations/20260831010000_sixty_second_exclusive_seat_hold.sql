-- ─────────────────────────────────────────────────────────────────────────────
-- SIXTY-SECOND EXCLUSIVE SEAT HOLD (Dan 2026-08-30)
--
-- "WHEN YOU HAVE A SEAT RESERVED, AND ITS YOUR TURN TO SIT DOWN, YOU SHOULD BE
--  GIVEN 60 SECONDS TO GET TO THAT SEAT, AND IT NEEDS TO BE RESERVED FOR THAT
--  PLAYER SPECIFICALLY. NO OTHER PLAYER SHOULD BE ABLE TO SIT, OR TAKE THAT
--  SEAT, AS ITS RESERVED FOR THE WAITING LIST IN ORDER."
--
-- Before this migration the offer was three minutes and RESERVED NOTHING: the
-- waitlist row flipped to 'notified' but the physical seat stayed open to
-- anybody who tapped it from the lobby. Two changes close that:
--
--   1. fn_offer_open_seat: offer TTL defaults to 60 seconds, and the claimed
--      row now carries hold_expires_at so the hold is a fact in the data, not
--      a function-signature default.
--   2. atomic_table_buyin: an active hold owned by someone else counts as an
--      occupied seat. When the open seats are all spoken for by holds, anyone
--      who is not a holder is refused with SEAT_RESERVED. Horses buy in
--      through this same RPC, so the rule binds everyone identically
--      (CLAUDE.md 10.5 — same rules for every player).
--
-- The hold also caps offers: a table never has more active holds than open
-- seats, so the queue is offered seats in order, one hold per open seat.
--
-- ROLLBACK:
--   ALTER TABLE public.table_waitlist DROP COLUMN IF EXISTS hold_expires_at;
--   Re-apply 20260830021000_offer_open_seat_in_one_transaction.sql and the
--   prior atomic_table_buyin definition (pg_get_functiondef before this ran).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.table_waitlist
  ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;

COMMENT ON COLUMN public.table_waitlist.hold_expires_at IS
  'While status=notified and this is in the future, one open seat at the table is reserved exclusively for this player. Set by fn_offer_open_seat (60s), honoured by atomic_table_buyin.';

CREATE OR REPLACE FUNCTION public.fn_offer_open_seat(
  p_table_id  uuid,
  p_offer_ttl interval DEFAULT interval '60 seconds',
  p_entry_ttl interval DEFAULT interval '24 hours'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_tbl      record;
  v_next     record;
  v_notif_id uuid;
  v_expired  int := 0;
  v_holds    int := 0;
BEGIN
  SELECT t.id, t.name, t.tournament_id, t.max_players, t.current_players
    INTO v_tbl
    FROM public.tables t
   WHERE t.id = p_table_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF v_tbl.tournament_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_table');
  END IF;

  IF COALESCE(v_tbl.current_players, 0) >= COALESCE(v_tbl.max_players, 9) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_full');
  END IF;

  -- 1. RECLAIM DEAD OFFERS, AND SAY SO. The hold expiry is the row's own
  --    hold_expires_at; rows written before this migration fall back to
  --    notified_at + TTL.
  WITH dead AS (
    UPDATE public.table_waitlist
       SET status = 'expired'
     WHERE table_id = p_table_id
       AND status = 'notified'
       AND COALESCE(hold_expires_at, notified_at + p_offer_ttl) < now()
    RETURNING user_id
  )
  INSERT INTO public.notifications (user_id, type, title, message, data)
  SELECT d.user_id,
         'waitlist_offer_expired',
         'Seat Offer Expired',
         'Your Seat At ' || COALESCE(v_tbl.name, 'The Table') ||
           ' Went To The Next Player In Line. Join The Waitlist Again To Get Back In.',
         jsonb_build_object('table_id', p_table_id, '_push', 'skip')
    FROM dead d;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- 2. ABANDONED PLACES IN LINE.
  UPDATE public.table_waitlist
     SET status = 'expired'
   WHERE table_id = p_table_id
     AND status = 'waiting'
     AND created_at < now() - p_entry_ttl;

  -- 3. ALREADY SITTING AT THIS TABLE.
  UPDATE public.table_waitlist w
     SET status = 'seated'
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = p_table_id
          AND s.left_at IS NULL
          AND s.user_id = w.user_id
     );

  -- 3.5 ONE HOLD PER OPEN SEAT. Offering a second player a table with one open
  --     seat already held would promise a seat that does not exist.
  SELECT COUNT(*) INTO v_holds
    FROM public.table_waitlist
   WHERE table_id = p_table_id
     AND status = 'notified'
     AND COALESCE(hold_expires_at, notified_at + p_offer_ttl) > now();

  IF COALESCE(v_tbl.current_players, 0) + v_holds >= COALESCE(v_tbl.max_players, 9) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'open_seats_already_held', 'offers_expired', v_expired
    );
  END IF;

  -- 4. THE HEAD OF THE QUEUE, LOCKED.
  SELECT w.id, w.user_id
    INTO v_next
    FROM public.table_waitlist w
    JOIN public.profiles p ON p.id = w.user_id
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND NOT COALESCE(p.is_horse, false)
   ORDER BY w.created_at
     FOR UPDATE OF w SKIP LOCKED
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'nobody_waiting', 'offers_expired', v_expired
    );
  END IF;

  UPDATE public.table_waitlist
     SET status = 'notified',
         notified_at = now(),
         hold_expires_at = now() + p_offer_ttl
   WHERE id = v_next.id;

  INSERT INTO public.notifications (user_id, type, title, message, data)
  VALUES (
    v_next.user_id,
    'waitlist_seat_open',
    'Seat Open',
    'A Seat Just Opened At ' || COALESCE(v_tbl.name, 'Your Waitlisted Table') ||
      '. It Is Held For You For 60 Seconds. Sit Down Now To Claim It.',
    jsonb_build_object('table_id', p_table_id)
  )
  RETURNING id INTO v_notif_id;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_next.user_id,
    'table_name', v_tbl.name,
    'notification_id', v_notif_id,
    'hold_expires_in_seconds', EXTRACT(epoch FROM p_offer_ttl)::int,
    'offers_expired', v_expired
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM anon;
REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) TO service_role;

COMMENT ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) IS
  'Offers an open cash seat to the longest-waiting HUMAN on the table waitlist. Since 2026-08-31 the offer is a 60-second EXCLUSIVE hold (hold_expires_at): atomic_table_buyin refuses everyone else the reserved seat, and no more holds are issued than there are open seats.';

-- ── ATOMIC_TABLE_BUYIN: HOLDS COUNT AS OCCUPIED SEATS ────────────────────────
-- Only the capacity section changes plus a seated-marks-your-row step; every
-- other line is byte-identical to the live definition captured before this ran.
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
  v_holds integer := 0;
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
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO public.transaction_idempotency_keys (key, user_id, action, amount)
        VALUES (p_idempotency_key, p_user_id, 'atomic_table_buyin', p_amount) ON CONFLICT (key) DO NOTHING;
        IF NOT FOUND THEN
            RETURN;
        END IF;
    END IF;
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot buy in for another user';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in, COALESCE(t.max_players, 0),
         COALESCE(t.no_rathole, false), COALESCE(t.is_vip_only, false), COALESCE(t.is_template, false)
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in, v_max_players,
         v_no_rathole, v_vip_only, v_is_template
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id LIMIT 1;

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

  IF v_vip_only THEN
    SELECT COALESCE(p.is_vip, false)
           AND (p.vip_expires_at IS NULL OR p.vip_expires_at > now())
      INTO v_is_vip
      FROM profiles p WHERE p.id = p_user_id LIMIT 1;

    IF NOT COALESCE(v_is_vip, false) AND v_club_id IS NOT NULL THEN
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

    -- SEAT HOLDS (Dan 2026-08-30). An unexpired offer to somebody ELSE counts
    -- as an occupied seat: while the open seats are all held for the waiting
    -- list, only the holders may sit. Applies to every caller of this RPC -
    -- humans from the lobby and horses seated by the fleet - identically.
    SELECT COUNT(*) INTO v_holds
      FROM public.table_waitlist w
     WHERE w.table_id = p_table_id
       AND w.status = 'notified'
       AND w.user_id <> p_user_id
       AND COALESCE(w.hold_expires_at, w.notified_at + interval '60 seconds') > now();
    IF v_seats_taken + v_holds >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for the next player on the waiting list'
        USING HINT = 'Join the waitlist to get the next seat in order.';
    END IF;
  END IF;

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

  -- The sitter's own waitlist rows at this table are settled: an offer they
  -- claimed, or a waiting row they bypassed by sitting, both become 'seated'
  -- so the hold is released the moment it is used.
  UPDATE public.table_waitlist
     SET status = 'seated'
   WHERE table_id = p_table_id
     AND user_id = p_user_id
     AND status IN ('waiting', 'notified');

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

-- Post-apply assertions.
DO $$
DECLARE v_probe jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'table_waitlist'
       AND column_name = 'hold_expires_at'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: table_waitlist.hold_expires_at missing';
  END IF;

  SELECT public.fn_offer_open_seat('00000000-0000-0000-0000-000000000000'::uuid) INTO v_probe;
  IF COALESCE(v_probe ->> 'reason', '') <> 'table_not_found' THEN
    RAISE EXCEPTION 'post-apply failed: unknown table probe answered %', v_probe;
  END IF;

  IF (SELECT pg_get_function_arguments(p.oid) FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_offer_open_seat'
      LIMIT 1) NOT LIKE '%00:01:00%' THEN
    RAISE EXCEPTION 'post-apply failed: fn_offer_open_seat default TTL is not 60 seconds (expected 00:01:00 in rendered arguments)';
  END IF;
END $$;
