-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260813033850 "phase58_hg_change_seat_game_guard_and_realtime_sync"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1e71400d438b603434292b0fed7765e1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 58 — rpc_hg_change_seat: parent-game guard, realtime sync, domain
--            errors. Brings it to parity with rpc_hg_claim_seat (phase53).
--
-- SCOPE NOTE / PARTIAL CORRECTION TO THE AUDIT
-- Finding F-24 said this RPC "never reads t.status, so players can move
-- seats on running tables and desync commander_home_seats". Moving a seat on
-- a RUNNING table is intentional — the BUG-1 block below explicitly syncs
-- commander_home_seats for exactly that case — so blocking on table status
-- would remove a working feature. Table status is deliberately NOT gated.
--
-- What is genuinely missing, and is fixed here:
--
--  1. NO PARENT-GAME STATUS CHECK. Like claim_seat before phase53, this only
--     ever looked at the reservation and the table. Game status is an
--     independent enum with no cascade, so seats remained movable on games
--     already 'cancelled' or 'completed' (both exist in production data).
--
--  2. REALTIME MISSES SEAT MOVES. The commander_home_seats sync sets
--     seat_number but NOT updated_at. Subscribers ordering or diffing on
--     updated_at never observe the move, so the Commander tablet view can
--     show a player in their old seat indefinitely.
--
--  3. RAW 23505 LEAKAGE. commander_home_seat_reservations_seat_lock and the
--     commander_home_seats unique index both surface as an opaque Postgres
--     unique_violation naming an internal index, so losing a race to a seat
--     appears as a 500 instead of "that seat was just taken".
--
-- Everything else is preserved byte-for-byte, including the BUG-1 seat-map
-- sync and the conditional shadow-write to commander_home_rsvps.
-- =====================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='rpc_hg_change_seat'
          AND pg_get_function_identity_arguments(p.oid) = 'p_reservation_id uuid, p_new_seat_number integer'
    ) THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: rpc_hg_change_seat(uuid,integer) not found — signature drift';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_hg_change_seat(p_reservation_id uuid, p_new_seat_number integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id  uuid := auth.uid();
  v_preview  RECORD;
  v_updated  RECORD;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT r.id, r.seat_number, r.status, r.user_id, r.claimed_by_user_id,
         r.table_id, r.is_guest, r.member_id,
         t.max_seats, t.game_id,
         g.status AS game_status
    INTO v_preview
    FROM public.commander_home_seat_reservations r
    JOIN public.commander_home_game_tables t ON t.id = r.table_id
    JOIN public.commander_home_games g       ON g.id = t.game_id
   WHERE r.id = p_reservation_id;
  IF v_preview.id IS NULL THEN RAISE EXCEPTION 'RESERVATION_NOT_FOUND'; END IF;

  -- FIX 1: parent game must still be live. Table status is intentionally NOT
  -- gated — moving seats on a running table is supported (see BUG-1 below).
  IF v_preview.game_status IS NOT NULL
     AND v_preview.game_status IN ('cancelled','completed') THEN
    RAISE EXCEPTION 'GAME_NOT_ACTIVE' USING HINT = v_preview.game_status;
  END IF;

  IF v_preview.user_id IS DISTINCT FROM v_user_id
     AND v_preview.claimed_by_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'NOT_YOUR_RESERVATION';
  END IF;

  IF v_preview.status NOT IN ('reserved','seated') THEN
    RAISE EXCEPTION 'RESERVATION_INACTIVE';
  END IF;

  IF p_new_seat_number < 1 OR p_new_seat_number > v_preview.max_seats THEN
    RAISE EXCEPTION 'SEAT_OUT_OF_BOUNDS';
  END IF;

  IF p_new_seat_number = v_preview.seat_number THEN
    RETURN p_reservation_id;
  END IF;

  -- FIX 3: map the seat-lock race to a domain error.
  BEGIN
    UPDATE public.commander_home_seat_reservations
       SET seat_number = p_new_seat_number,
           updated_at  = now()
     WHERE id = p_reservation_id
       AND status IN ('reserved','seated')
       AND (user_id = v_user_id OR claimed_by_user_id = v_user_id)
    RETURNING id, table_id, seat_number, user_id, is_guest, status
         INTO v_updated;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'SEAT_TAKEN';
  END;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESERVATION_INACTIVE'
      USING HINT = 'reservation was just released or reassigned';
  END IF;

  -- BUG-1 fix: if reservation was 'seated' (table running), sync the
  -- live seat map too. commander_home_seats has its own (table_id,
  -- seat_number) unique-index so this will error cleanly if the target
  -- seat is already occupied there — which in practice cannot happen
  -- because the reservations unique-index already blocked it.
  --
  -- FIX 2: also bump updated_at. Without it, realtime subscribers that
  -- order or diff on updated_at never observe a seat move and the
  -- Commander tablet view shows the player in their old seat.
  IF v_updated.status = 'seated' THEN
    BEGIN
      UPDATE public.commander_home_seats
         SET seat_number = p_new_seat_number,
             updated_at  = now()
       WHERE reservation_id = p_reservation_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'SEAT_TAKEN';
    END;
  END IF;

  -- Shadow-write to rsvps: only if it was pointing at the OLD seat.
  IF v_updated.is_guest = false AND v_updated.user_id IS NOT NULL THEN
    UPDATE public.commander_home_rsvps
       SET seat_number = v_updated.seat_number,
           updated_at  = now()
     WHERE game_id    = v_preview.game_id
       AND user_id    = v_updated.user_id
       AND seat_number IS NOT DISTINCT FROM v_preview.seat_number;
  END IF;

  RETURN p_reservation_id;
END $function$;

-- ---------- POST-APPLY ----------
DO $$
DECLARE v_src text;
BEGIN
    SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='rpc_hg_change_seat';

    IF v_src NOT LIKE '%GAME_NOT_ACTIVE%'      THEN RAISE EXCEPTION 'POST-APPLY FAILED: game guard missing'; END IF;
    IF v_src NOT LIKE '%SEAT_TAKEN%'           THEN RAISE EXCEPTION 'POST-APPLY FAILED: race mapping missing'; END IF;
    IF v_src NOT LIKE '%commander_home_seats%' THEN RAISE EXCEPTION 'POST-APPLY FAILED: BUG-1 seat-map sync was lost'; END IF;
    IF v_src NOT LIKE '%commander_home_rsvps%' THEN RAISE EXCEPTION 'POST-APPLY FAILED: rsvp shadow-write was lost'; END IF;

    RAISE NOTICE 'phase58 OK: change_seat at parity with claim_seat.';
END $$;
