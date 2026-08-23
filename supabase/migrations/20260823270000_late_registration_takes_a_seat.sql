-- ============================================================================
-- 20260823270000_late_registration_takes_a_seat.sql
-- TIER: 2  |  AFFECTS: new fn_seat_late_registrant, fn_register_for_tournament.
--
-- WHAT DAN SAW
--
-- 2026-08-23: "I REGISTERED FOR A TOURNAMENT DURING LATE REGISTRATION... IT
-- TOOK ME TO THE PAGE, BUT DIDN'T SIT ME, GIVE ME CHIPS OR ANYTHING."
--
-- Every word of that is what the code does.
--
-- THE FAULT
--
-- fn_register_for_tournament writes ONE row and stops:
--
--     INSERT INTO tournament_players (..., chips, status)
--     VALUES (..., v_start_chips, 'registered')
--
-- chips is 0 for anyone without an early-bird bonus, status is 'registered',
-- and table_id and seat_number are left NULL. For a tournament that has not
-- started that is exactly right — start() migrates the 'registered' rows,
-- creates the tables and seats the field.
--
-- For a LATE registration there is no start() left to run. The tables already
-- exist, the blinds are already at level eight, and nothing in the transaction
-- puts the new entrant on one of them. He is a paid-up entrant with no seat
-- and no chips.
--
-- The client then made it worse rather than better. useTournamentRegistration
-- reads back the row it just created, finds table_id NULL, and falls through
-- to "find any table of this tournament and navigate there" — which lands the
-- player on somebody else's table as a SPECTATOR, under a footer reading
-- "Spectating, Tap An Open Seat To Join". He cannot: every seat on an MTT
-- table is deliberately non-interactive. The product told him to do the one
-- thing it had just made impossible.
--
-- The engine does carry a repair — TournamentManager.ensureLateRegSeated seats
-- unseated entrants on its 5s sweep — but it is a backstop, not the contract.
-- It only runs when a live TournamentManager owns that tournament, and it
-- cannot help the player already staring at a spectator screen one second
-- after paying.
--
-- WHAT THIS MIGRATION DOES
--
--   fn_seat_late_registrant(tournament, user) — puts a paid entrant in a real
--   seat at a real table with the real starting stack, in one transaction:
--   busiest-but-not-full table first (so a late field does not spread into a
--   dozen three-handed tables the balancer then has to break), lowest free
--   seat, stack = starting_chips + whatever early-bird bonus the row already
--   carried, reusing a vacated seat row before inserting a new one — the 23505
--   trap that made the TypeScript sweep skip some players forever.
--
--   fn_register_for_tournament calls it whenever it admitted somebody under
--   the late-registration branch, so registration and seating are one
--   decision. The read-back the client already performs then finds table_id
--   set and navigates the player to their own seat.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
--   Nothing changes for a pre-start registration: those rows stay 'registered'
--   at 0 chips and are still seated by start(). Seat-first buy-ins
--   (fn_take_seat_and_buy_in) reach registration through the
--   ANNOUNCED/REGISTERING branch and are untouched.
--
--   If every table is full it seats nobody and says so. The entrant stays
--   'registered', which is precisely the state checkDynamicTableExpansion
--   counts — a table spawns and the sweep seats them next cycle. Inventing a
--   tenth seat at a nine-handed table would be worse than waiting five
--   seconds.
--
-- ROLLBACK
--
--   Restore the previous fn_register_for_tournament body (this one minus the
--   single late-seat block) and:
--   DROP FUNCTION IF EXISTS public.fn_seat_late_registrant(uuid, uuid);
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_seat_late_registrant(
  p_tournament_id uuid,
  p_user_id uuid
)
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
BEGIN
  SELECT status, COALESCE(starting_chips, 0), club_id
    INTO v_status, v_start_chips, v_club
    FROM public.tournaments WHERE id = p_tournament_id;

  IF v_status IS DISTINCT FROM 'RUNNING' THEN
    -- Not a late entry. start() owns the seating for everything else.
    RETURN jsonb_build_object('ok', false, 'reason', 'not_running');
  END IF;

  -- The row must exist and still be waiting for a seat. Re-seating a player
  -- who already has one is how duplicate seats get made.
  SELECT COALESCE(chips, 0) INTO v_bonus
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND user_id = p_user_id
     AND table_id IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_seated_or_missing');
  END IF;

  -- The early-bird bonus already sitting in `chips` is ADDED to the starting
  -- stack, never overwritten by it — the mistake that silently destroyed every
  -- bonus ever granted before 2026-08-22.
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

  IF v_table IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_open_seat');
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

  -- Reuse the vacated row for this seat before inserting. table_seats carries
  -- UNIQUE (table_id, seat_number) with no left_at predicate, so a blind
  -- INSERT onto a seat somebody has left raises 23505 every single time.
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
      -- Somebody took it in the same instant. The entrant keeps their paid
      -- 'registered' row and the 5s sweep seats them.
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
    'seat_number', v_seat, 'chips', v_chips);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_seat_late_registrant(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_seat_late_registrant(uuid, uuid) TO service_role;

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_seat_late_registrant'
  ) THEN
    RAISE EXCEPTION 'fn_seat_late_registrant was not created';
  END IF;
END $$;

-- ============================================================================
-- fn_register_for_tournament — unchanged except for the late-seat call.
--
-- Body reproduced verbatim from production (pg_get_functiondef, 2026-08-23)
-- with exactly two additions, both marked LATE SEAT 2026-08-23:
--   * a v_seat jsonb declaration
--   * the fn_seat_late_registrant call and its two result keys
--
-- Everything else — the row lock, the late-reg window, the capacity and
-- duplicate checks, the authorised/VIP gates, the early-bird credit, the
-- mystery-bounty roll, the wallet debit and its ledger row, the entry-fee rake
-- record and the counter bump — is byte-for-byte what was already deployed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0; v_mystery numeric := 0;
  v_roll numeric; v_mult numeric; v_player_id uuid;
  v_late_open boolean := false; v_ok boolean;
  v_start_chips integer := 0;
  v_mb_min_mult numeric; v_mb_max_mult numeric;
  v_seat jsonb := NULL;                                  -- LATE SEAT 2026-08-23
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         late_reg_levels, late_reg_mins, current_level, started_at, club_id, name,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount, mystery_bounty_min, mystery_bounty_max,
         start_time, authorized_to_register, is_vip_only, early_bird_enabled, early_bird_chips
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  IF v_t.status = 'RUNNING' THEN
    IF COALESCE(v_t.late_reg_levels, 0) > 0 THEN
      v_late_open := COALESCE(v_t.current_level, 1) <= v_t.late_reg_levels;
    ELSIF COALESCE(v_t.late_reg_mins, 0) > 0 AND v_t.started_at IS NOT NULL THEN
      v_late_open := now() < v_t.started_at + make_interval(mins => v_t.late_reg_mins);
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

  -- PARITY GATE 2 (2026-08-22): VIP-only events. club_members carries no VIP
  -- column (inspected 2026-08-22); profiles.is_vip / vip_expires_at is the
  -- platform VIP flag. Club owner/admin/agent may always enter their own event.
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

  IF v_is_bounty THEN
    v_head := v_split.bounty;
    IF COALESCE(v_t.is_mystery_bounty, false) AND v_head > 0 THEN
      v_roll := random() * 100;
      IF    v_roll < 60 THEN v_mult := 0.5;
      ELSIF v_roll < 85 THEN v_mult := 1;
      ELSIF v_roll < 95 THEN v_mult := 2;
      ELSIF v_roll < 99 THEN v_mult := 3;
      ELSE                   v_mult := 13;
      END IF;
      -- PARITY 4 (2026-08-22): rescale ladder to the advertised money range.
      IF COALESCE(v_t.mystery_bounty_min, 0) > 0
         AND COALESCE(v_t.mystery_bounty_max, 0) > v_t.mystery_bounty_min THEN
        v_mb_min_mult := v_t.mystery_bounty_min / v_head;
        v_mb_max_mult := v_t.mystery_bounty_max / v_head;
        v_mult := v_mb_min_mult + (v_mult - 0.5) * (v_mb_max_mult - v_mb_min_mult) / 12.5;
      END IF;
      v_mystery := round(v_head * v_mult, 2);
      v_head := v_mystery;
    END IF;
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
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, v_mystery, 0, 0)
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

  -- ── LATE SEAT 2026-08-23 ──────────────────────────────────────────────────
  -- A late entrant is admitted into a tournament that is ALREADY DEALING.
  -- There is no start() left to seat him, so the seat is part of the same
  -- transaction as the debit: he is either a seated player with chips, or he
  -- did not pay. A refusal here (every table full, or a seat race) is not an
  -- error — the row stays 'registered' and the engine's 5s sweep seats him.
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, v_uid);
  END IF;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'bounty_head', CASE WHEN v_head > 0 THEN v_head END,
    'mystery_bounty', CASE WHEN v_mystery > 0 THEN v_mystery END,
    'early_bird_chips', CASE WHEN v_start_chips > 0 THEN v_start_chips END,
    'late_registration', v_late_open,                    -- LATE SEAT 2026-08-23
    'seat', v_seat);                                     -- LATE SEAT 2026-08-23
END; $function$;

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_register_for_tournament';

  IF v_src IS NULL OR position('fn_seat_late_registrant' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_register_for_tournament does not call fn_seat_late_registrant';
  END IF;

  -- The gates that protect the money must all still be present. This is the
  -- guard against a future rewrite of this function quietly dropping one.
  IF position('atomic_deduct_wallet_and_log' in v_src) = 0
     OR position('rake_records' in v_src) = 0
     OR position('already_registered' in v_src) = 0
     OR position('tournament_full' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_register_for_tournament lost a money or capacity gate';
  END IF;
END $$;
