-- 20260910184427_the_door_honours_the_chair_the_game_promised
--
-- Version reserved by scripts/reserve-migration-version.sh (CLAUDE.md 4.5).
-- Lane B follow-up of the 2026-09-09 must-move audit, finding F10
-- (docs/audits/2026-09-09-must-move-audit/lane-B.md, section 8). NOT applied
-- by the lane; probed ROLLED BACK with psql and handed over.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE DOOR HONOURS THE CHAIR THE GAME PROMISED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG. The cluster tick plans a must-move into an open chair and
-- every count of open chairs treats that plan as a reservation:
-- `fn_cash_game_open_seats` subtracts pending unlinked `cash_seat_moves`, the
-- planner subtracts them, the break step subtracts them, the lobby reads them
-- subtracted. The buy-in door did not. `atomic_table_buyin_before_maintenance_announcement_gate`
-- counted seats taken plus live `table_waitlist` holds and nothing else, so a
-- browser - or the horse fleet, through the same door - could take the chair
-- the game had promised to a mover, and the mover was refused at the boundary
-- with `destination_full`. MEASURED 2026-09-10: 41 `destination_full`
-- cancellations in 24 hours, 17 of them with a fresh buy-in by another player
-- landing on the destination inside the move's window. The door and the
-- census disagreed about the same chair.
--
-- WHAT THIS DOES. One clause beside the hold count, in the same shape:
--
--     SELECT COUNT(*) INTO v_moves FROM public.cash_seat_moves m
--      WHERE m.to_table_id = p_table_id AND m.state = 'pending'
--        AND m.swap_move_id IS NULL AND m.player_id <> p_user_id;
--     IF v_seats_taken + v_holds + v_moves >= v_max_players THEN
--       RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for a player the game is moving here'
--
-- EVERY REASON A PENDING MOVE CAN EXIST FOR A DESTINATION, and whether it is
-- a reservation (the `cash_seat_moves_reason_check` allows exactly four):
--
--   must_move    - the tick's step 2 fills a Main's open chair from the list.
--                  RESERVATION: the chair is empty and promised.
--   break        - the tick's step 5 moves a breaking table's players to the
--                  shortest table with room. RESERVATION.
--   balance      - fn_cash_cluster_balance evens the feeders. RESERVATION.
--   seat_change  - the planner found an open chair for a request.
--                  RESERVATION.
--   seat_change, linked (swap_move_id IS NOT NULL) - two players exchange
--                  two OCCUPIED chairs; neither chair is empty and nothing is
--                  promised out of the open count. NOT A RESERVATION, and the
--                  2026-09-05 lobby changelog says so in as many words ("A
--                  swap is not a reservation: every count of pending moves to
--                  a table now excludes linked rows").
--
-- The clause counts EXACTLY what `fn_cash_game_open_seats` counts:
-- `m.to_table_id = t.id AND m.state = 'pending' AND m.swap_move_id IS NULL` -
-- no reason filter, no expires_at filter (the tick expires a lapsed move
-- within one 5 s pass, and the two readers must agree in the meantime, which
-- is the whole point) - plus `m.player_id <> p_user_id`, so a player is never
-- refused by their own reservation. (A player with a pending move is seated
-- elsewhere in the same game, so their buy-in at the destination is refused
-- by the seat trigger's ALREADY_IN_GAME whatever this clause says; the
-- exclusion is what proves the clause itself did not refuse them. Probe S25.)
--
-- THE REFUSAL CODE is the existing `SEAT_RESERVED:` prefix with a message
-- that names the other cause. The client's buy-in refusal mapper
-- (`src/lib/cashBuyIn.ts`) matches `/^SEAT_RESERVED:/` and the 2026-09-09
-- recovery treats that prefix as a known, recoverable refusal (the attempt is
-- cleared, the sheet stays open, a new seat can be chosen). A NEW code would
-- have fallen into the unknown-outcome path and lost that recovery. The copy
-- the client shows today for the prefix is "This Seat Is Reserved For The
-- Next Player On The Waiting List. Please Join The Waitlist." - true enough
-- to act on, wrong about who. The lane G edit that would sharpen it, NOT made
-- here: in `src/lib/cashBuyIn.ts` before the `/^SEAT_RESERVED:/` line, add
--   if (/^SEAT_RESERVED: .*moving here/.test(m))
--     return 'This Chair Is Held For A Player The Game Is Moving Here. Tap Join Game For The Next Open Chair.';
--
-- HORSES ARE PLAYERS. The fleet walks through this door
-- (HorseFleetManager -> atomic_table_buyin) and `HorseBuyInRefusal.ts`
-- already classifies `SEAT_RESERVED` as `seat_reserved`, an expected and
-- counted seeding-race outcome: a horse is refused a promised chair exactly as
-- a human is, and a horse's promised chair refuses a human exactly the same
-- way. No `is_horse` in this migration; the post-apply assertion refuses a
-- gate body that reads it.
--
-- HOW THIS EDITS THE FUNCTION. The gate is the hottest money path on the
-- platform (fifteen migrations, every human and every horse). It is NOT
-- re-emitted: the live body is read with pg_get_functiondef and patched by
-- two anchored literal replacements (the DECLARE line, the hold block), each
-- refused if its anchor is absent, and the result is checked for every
-- landmark of the money path before it is executed. Guarded on the reviewed
-- live md5 823cfb123c2d5041ecc824d188a31997 and self-skipping.
--
-- ROLLBACK: put the hold block back to `IF v_seats_taken + v_holds >=
-- v_max_players THEN` with the original SEAT_RESERVED message and drop the
-- `v_moves` declaration - or restore the gate from
-- 20260908125930_maintenance_announcement_and_entry_purchases_are_serialized.
--
-- ONE transaction (production DDL policy, CLAUDE.md section 2).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_decl_anchor CONSTANT text := $old$  v_holds integer := 0;
  v_new_balance NUMERIC;$old$;
  v_decl_repl CONSTANT text := $new$  v_holds integer := 0;
  v_moves integer := 0;
  v_new_balance NUMERIC;$new$;
  v_anchor CONSTANT text := $old$    SELECT COUNT(*) INTO v_holds
      FROM public.table_waitlist w
     WHERE w.table_id = p_table_id
       AND w.status = 'notified'
       AND w.user_id <> p_user_id
       AND COALESCE(w.hold_expires_at, w.notified_at + interval '60 seconds') > now();
    IF v_seats_taken + v_holds >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for the next player on the waiting list'
        USING HINT = 'Join the waitlist to get the next seat in order.';
    END IF;$old$;
  v_repl CONSTANT text := $new$    SELECT COUNT(*) INTO v_holds
      FROM public.table_waitlist w
     WHERE w.table_id = p_table_id
       AND w.status = 'notified'
       AND w.user_id <> p_user_id
       AND COALESCE(w.hold_expires_at, w.notified_at + interval '60 seconds') > now();
    -- THE DOOR HONOURS THE CHAIR THE GAME PROMISED (2026-09-10). A pending
    -- must-move / break / balance / seat-change plan into this table is a
    -- reservation everywhere else (fn_cash_game_open_seats, the planner, the
    -- lobby); a linked swap row is not (both chairs are occupied). Counted
    -- here exactly as fn_cash_game_open_seats counts it, never against the
    -- player it is for.
    SELECT COUNT(*) INTO v_moves
      FROM public.cash_seat_moves m
     WHERE m.to_table_id = p_table_id
       AND m.state = 'pending'
       AND m.swap_move_id IS NULL
       AND m.player_id <> p_user_id;
    IF v_seats_taken + v_holds >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for the next player on the waiting list'
        USING HINT = 'Join the waitlist to get the next seat in order.';
    END IF;
    IF v_seats_taken + v_holds + v_moves >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for a player the game is moving here'
        USING HINT = 'Tap Join Game for the next open chair.';
    END IF;$new$;
BEGIN
  v_src := pg_get_functiondef('public.atomic_table_buyin_before_maintenance_announcement_gate'::regproc);
  IF position('THE DOOR HONOURS THE CHAIR THE GAME PROMISED' in v_src) > 0 THEN
    RAISE NOTICE 'buy-in gate already applied';
    RETURN;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure)
     <> '823cfb123c2d5041ecc824d188a31997' THEN
    RAISE EXCEPTION 'atomic_table_buyin_before_maintenance_announcement_gate is not the body this migration reviewed; re-read it before applying';
  END IF;
  IF position(v_decl_anchor in v_src) = 0 THEN
    RAISE EXCEPTION 'the gate''s DECLARE block is not in the shape this migration expects';
  END IF;
  IF position(v_anchor in v_src) = 0 THEN
    RAISE EXCEPTION 'the gate''s hold block is not in the shape this migration expects';
  END IF;
  v_new := replace(replace(v_src, v_decl_anchor, v_decl_repl), v_anchor, v_repl);
  -- Every landmark of the money path must survive the edit.
  IF position('THE DOOR HONOURS THE CHAIR THE GAME PROMISED' in v_new) = 0
     OR position($q$set_config('app.money_path', 'atomic_table_buyin', true)$q$ in v_new) = 0
     OR position('transaction_idempotency_keys' in v_new) = 0
     OR position('fn_caller_session_is_live' in v_new) = 0
     OR position('fn_cash_rejoin_floor' in v_new) = 0
     OR position('BUYIN_BELOW_FLOOR' in v_new) = 0
     OR position('Banned from this club' in v_new) = 0
     OR position('VIP_ONLY' in v_new) = 0
     OR position('fn_nit_check' in v_new) = 0
     OR position('Player already seated at this table' in v_new) = 0
     OR position($q$hashtextextended('table_seat:' || p_table_id::text, 0)$q$ in v_new) = 0
     OR position('TABLE_SIZE: table is full' in v_new) = 0
     OR position('TABLE_CAP_REACHED' in v_new) = 0
     OR position('fn_seat_club_for_user' in v_new) = 0
     OR position('fn_ensure_club_wallet' in v_new) = 0
     OR position('chip_balance = chip_balance - p_amount' in v_new) = 0
     OR position('Insufficient club chips for buy-in' in v_new) = 0
     OR position('fn_cash_session_open' in v_new) = 0
     OR position('wallet_transactions' in v_new) = 0
     OR position('is_horse' in v_new) > 0 THEN
    RAISE EXCEPTION 'a landmark of the buy-in gate went missing in the edit';
  END IF;
  EXECUTE v_new;
END;
$migration$;

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────
DO $assert$
DECLARE v_gate text; v_open text;
BEGIN
  v_gate := (SELECT prosrc FROM pg_proc WHERE oid = 'public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure);
  v_open := (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_cash_game_open_seats(uuid)'::regprocedure);
  IF position($q$AND m.swap_move_id IS NULL
       AND m.player_id <> p_user_id;$q$ in v_gate) = 0 THEN
    RAISE EXCEPTION 'the gate does not count the planner''s reservations, or counts a swap or the player''s own';
  END IF;
  IF position('SEAT_RESERVED: the open seat is held for a player the game is moving here' in v_gate) = 0 THEN
    RAISE EXCEPTION 'the promised-chair refusal is not named';
  END IF;
  IF position('SEAT_RESERVED: the open seat is held for the next player on the waiting list' in v_gate) = 0 THEN
    RAISE EXCEPTION 'the waiting-list refusal was lost';
  END IF;
  -- The two readers must count the same rows: pending, unlinked, into this table.
  IF position($q$m.state = 'pending' AND m.swap_move_id IS NULL$q$ in v_open) = 0 THEN
    RAISE EXCEPTION 'fn_cash_game_open_seats no longer counts pending unlinked moves the way the door now does';
  END IF;
  IF position('is_horse' in v_gate) > 0 THEN
    RAISE EXCEPTION 'the buy-in gate must not read is_horse (CLAUDE.md 10.5)';
  END IF;
  -- The grants on the gate are untouched by the edit; say so.
  IF has_function_privilege('anon', 'public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the inner buy-in gate';
  END IF;
END;
$assert$;

COMMIT;
