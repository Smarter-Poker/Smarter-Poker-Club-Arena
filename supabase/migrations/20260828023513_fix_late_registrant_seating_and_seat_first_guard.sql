-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828023513; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Money-path audit 2026-08-27, lanes: MTT lobby-to-seat, and Heads-Up
--
-- THREE defects, all confirmed live against prod.
--
-- 1. CRITICAL - a late registrant could be charged and left with no seat.
--    fn_seat_late_registrant returns 'no_open_seat' when every table is full.
--    It never opens a new one. fn_register_for_tournament calls it on the very
--    last line and then returns ok:true regardless of the answer, with the
--    buy-in already debited. The DB backstop that would catch the orphan scans
--    status = 'registered', and the engine's own sweep promotes exactly these
--    players to 'playing', so the sweeper can no longer see them.
--
--    Fixed in two places: the seater now opens a table rather than refusing,
--    and the registrar now treats a failed seat as fatal.
--
-- 2. CRITICAL - a human can pay for a Heads-Up seat through the MTT register
--    button and never get seated. Heads-Up and Spin boards are SEAT-FIRST: you
--    buy in by taking a seat via fn_take_seat_and_buy_in. fn_register_for_tournament
--    has no variant filter, so it debits the wallet and inserts a roster row
--    without taking a seat; the seat counter then overwrites current_players,
--    the start gate counts seats and stays 0/2, and the unseated-registrant
--    sweep only ever seats horses. The paid human watches two horses play the
--    duel he bought into.
--
--    34 roster rows on max_players=2 events currently have a null seat_number.
--    All 34 are horses - it has not burned a human yet.
--
--    The guard is safe against the horse path by construction: this function
--    raises 28000 when auth.uid() is null, so a service-role or cron caller can
--    never reach it. Every call is a human. Refusing seat-first variants here
--    therefore cannot affect how horses are seated.
--
-- 3. The registrar swallowed the seat result. Now, when late registration is
--    open and seating genuinely fails, the whole transaction is aborted - which
--    rolls back the wallet debit, the roster row, the rake record and the pool
--    increments together. The player keeps their money and sees a real error
--    instead of a green tick and no seat.
--
-- NOTE for the engine team: opening a table mid-tournament from SQL means the
-- engine must pick up a table that appeared without it asking. Verify the table
-- poller does that. The alternative - charging a player for a seat that does not
-- exist - is strictly worse, which is why this ships now.

CREATE OR REPLACE FUNCTION public.fn_seat_late_registrant(p_tournament_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_status text;
  v_start_chips integer;
  v_club uuid;
  v_bonus integer;
  v_chips integer;
  v_table uuid;
  v_cap int;
  v_seat int;
  v_taken int;
  v_opened boolean := false;
  v_sb numeric; v_bb numeric; v_bs varchar; v_tclub uuid; v_tno int;
BEGIN
  SELECT status, COALESCE(starting_chips, 0), club_id
    INTO v_status, v_start_chips, v_club
    FROM public.tournaments WHERE id = p_tournament_id;

  IF v_status IS DISTINCT FROM 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_running');
  END IF;

  SELECT COALESCE(chips, 0) INTO v_bonus
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND user_id = p_user_id
     AND table_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        JOIN public.tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = p_tournament_id
         AND s.user_id = p_user_id
         AND s.left_at IS NULL
     )
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_seated_or_missing');
  END IF;

  v_chips := v_start_chips + GREATEST(v_bonus, 0);

  SELECT tb.id, COALESCE(tb.max_players, 9)
    INTO v_table, v_cap
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) IN ('waiting', 'running', 'active')
     AND (
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id = tb.id AND s.left_at IS NULL
     ) < COALESCE(tb.max_players, 9)
   ORDER BY (
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id = tb.id AND s.left_at IS NULL
     ) DESC, tb.created_at ASC
   LIMIT 1
     FOR UPDATE OF tb;

  -- SEAT FIX 2026-08-27: every table is full, so open one instead of refusing.
  -- Blinds, cap and structure are copied from the newest sibling table so the
  -- new felt joins at the level the tournament is actually playing.
  IF v_table IS NULL THEN
    SELECT COALESCE(tb.max_players, 9), tb.small_blind, tb.big_blind,
           tb.blind_structure, COALESCE(tb.club_id, v_club)
      INTO v_cap, v_sb, v_bb, v_bs, v_tclub
      FROM public.tables tb
     WHERE tb.tournament_id = p_tournament_id
     ORDER BY tb.created_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
      SELECT COALESCE(t.table_size, 9) INTO v_cap
        FROM public.tournaments t WHERE t.id = p_tournament_id;
      v_sb := 1; v_bb := 2; v_bs := 'standard'; v_tclub := v_club;
    END IF;

    SELECT count(*) + 1 INTO v_tno
      FROM public.tables WHERE tournament_id = p_tournament_id;

    INSERT INTO public.tables
      (name, tournament_id, club_id, max_players, small_blind, big_blind,
       blind_structure, status, current_players)
    VALUES ('Table ' || v_tno, p_tournament_id, v_tclub, v_cap, v_sb, v_bb,
            COALESCE(v_bs, 'standard'), 'waiting', 0)
    RETURNING id INTO v_table;

    v_opened := true;
  END IF;

  SELECT g.n INTO v_seat
    FROM generate_series(1, v_cap) AS g(n)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.table_seats s
      WHERE s.table_id = v_table AND s.seat_number = g.n AND s.left_at IS NULL
   )
   ORDER BY g.n LIMIT 1;

  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_open_seat');
  END IF;

  UPDATE public.table_seats
     SET user_id        = p_user_id,
         stack          = v_chips,
         left_at        = NULL,
         joined_at      = now(),
         is_sitting_out = false,
         is_away        = false,
         club_id        = COALESCE(club_id, v_club)
   WHERE table_id = v_table AND seat_number = v_seat AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack, club_id)
      VALUES (v_table, p_user_id, v_seat, v_chips, v_club);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'seat_race');
    END;
  END IF;

  UPDATE public.tournament_players
     SET status      = 'playing',
         chips       = v_chips,
         table_id    = v_table,
         seat_number = v_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  SELECT count(*) INTO v_taken
    FROM public.table_seats WHERE table_id = v_table AND left_at IS NULL;
  UPDATE public.tables SET current_players = v_taken WHERE id = v_table;

  RETURN jsonb_build_object('ok', true, 'table_id', v_table,
    'seat_number', v_seat, 'chips', v_chips, 'opened_table', v_opened);
END;
$fn$;


CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_late_open boolean := false; v_ok boolean;
  v_start_chips integer := 0;
  v_seat jsonb := NULL;                                  -- LATE SEAT 2026-08-23
  v_seat_reason text;                                    -- SEAT FIX 2026-08-27
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         late_reg_levels, late_reg_mins, current_level, started_at, club_id, name, prize_pool_finalized,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         start_time, authorized_to_register, is_vip_only, early_bird_enabled, early_bird_chips,
         variant
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  -- SEAT-FIRST GUARD 2026-08-27. See migration header, defect 2. Spin and SNG
  -- (which is where every Heads-Up event lives) are bought by taking a seat.
  -- Registering into one debits the player for a seat that is never allocated.
  IF COALESCE(v_t.variant, '') IN ('spin', 'sng') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_first_variant',
      'detail', 'This format is entered by taking a seat, not by registering. '
                || 'Call fn_take_seat_and_buy_in for the seat you want.',
      'variant', v_t.variant);
  END IF;

  IF v_t.status = 'RUNNING' THEN
    IF COALESCE(v_t.late_reg_levels, 0) > 0 THEN
      v_late_open := COALESCE(v_t.current_level, 0) < v_t.late_reg_levels AND NOT COALESCE(v_t.prize_pool_finalized, false);
    ELSIF COALESCE(v_t.late_reg_mins, 0) > 0 AND v_t.started_at IS NOT NULL THEN
      v_late_open := now() < v_t.started_at + make_interval(mins => v_t.late_reg_mins) AND NOT COALESCE(v_t.prize_pool_finalized, false);
    END IF;
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  IF v_t.max_players IS NOT NULL AND COALESCE(v_t.current_players, 0) >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = p_tournament_id AND user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  -- PARITY GATE 1 (2026-08-22): owner-approved registration list.
  IF COALESCE(v_t.authorized_to_register, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournament_registration_approvals a
                    WHERE a.tournament_id = p_tournament_id AND a.user_id = v_uid)
       AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized_to_register');
    END IF;
  END IF;

  -- PARITY GATE 2 (2026-08-22): VIP-only events.
  IF COALESCE(v_t.is_vip_only, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles pr
                    WHERE pr.id = v_uid AND COALESCE(pr.is_vip, false)
                      AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at > now()))
       AND NOT EXISTS (SELECT 1 FROM public.club_members m
                        WHERE m.club_id = v_t.club_id AND m.user_id = v_uid
                          AND m.role IN ('owner', 'admin', 'agent')) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'vip_only');
    END IF;
  END IF;

  -- PARITY 3 (2026-08-22): early bird bonus chips for pre-start registration.
  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = v_uid;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty',
      'detail', format('bounty %s + rake %s exceeds buy-in %s',
                       v_split.bounty, v_split.rake, v_split.charge));
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: the random() roll that used to sit here is
  -- GONE. Every bounty format, mystery included, puts the flat bounty on the
  -- head; the mystery value is drawn from a funded inventory at the knockout,
  -- not from a seeded PRNG at the till.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 THEN
    v_ok := public.atomic_deduct_wallet_and_log(
      v_uid, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament') ||
        CASE WHEN v_is_bounty
             THEN ' (' || v_split.prize || ' prize + ' || v_split.bounty || ' bounty + ' || v_split.rake || ' fee)'
             WHEN v_split.rake > 0
             THEN ' (' || v_split.prize || ' + ' || v_split.rake || ' fee)'
             ELSE '' END,
      NULL, NULL, p_tournament_id);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      v_uid, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    IF v_split.charge > 0 THEN
      PERFORM public.credit_player_wallet(v_uid, v_split.charge,
        'tourn_reg_race:' || p_tournament_id::text || ':' || v_uid::text);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',v_uid,'registration_id',v_player_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id;

  -- LATE SEAT 2026-08-23
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, v_uid);

    -- SEAT FIX 2026-08-27: this result used to be dropped on the floor and the
    -- function returned ok:true with the buy-in already taken. A late registrant
    -- who cannot be seated must not be charged, so abort and let the whole
    -- transaction - debit, roster row, rake record, pool increments - roll back
    -- together. 'already_seated_or_missing' is NOT a failure: it means the
    -- player already holds a live seat.
    v_seat_reason := v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean, false)
       AND COALESCE(v_seat_reason, '') <> 'already_seated_or_missing' THEN
      RAISE EXCEPTION
        'Late registration could not seat the player (%) — no charge has been made',
        COALESCE(v_seat_reason, 'unknown')
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'bounty_head', CASE WHEN v_head > 0 THEN v_head END,
    'early_bird_chips', CASE WHEN v_start_chips > 0 THEN v_start_chips END,
    'late_registration', v_late_open,                    -- LATE SEAT 2026-08-23
    'seat', v_seat);                                     -- LATE SEAT 2026-08-23
END;
$fn$;
