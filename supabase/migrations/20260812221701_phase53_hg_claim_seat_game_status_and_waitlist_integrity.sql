-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812221701 "phase53_hg_claim_seat_game_status_and_waitlist_integrity"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6b47b0b5de2885c45bfb7cd4681a95cd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 53 — rpc_hg_claim_seat: parent-game status guard, waitlist
--            integrity, and domain-mapped race errors
--
-- SCOPE NOTE / CORRECTION TO THE AUDIT:
-- The audit asserted there was no per-user seat cap and that a member could
-- loop-claim every seat. That is NOT true in production - three partial
-- unique indexes already enforce it at the storage layer:
--   commander_home_seat_reservations_seat_lock
--       UNIQUE (table_id, seat_number)        WHERE status IN (reserved,seated)
--   commander_home_seat_reservations_user_table_active
--       UNIQUE (table_id, user_id)            WHERE status IN (reserved,seated)
--                                               AND user_id IS NOT NULL AND is_guest=false
--   commander_home_seat_reservations_one_guest_per_user_per_table
--       UNIQUE (table_id, claimed_by_user_id) WHERE is_guest AND status IN (reserved,seated)
-- Those guarantees are intact and this migration does not touch them.
--
-- WHAT IS ACTUALLY BROKEN, and is fixed here:
--
--  1. NO PARENT-GAME STATUS CHECK. The function validates
--     commander_home_game_tables.status = 'open_for_rsvp' but never looks at
--     commander_home_games.status. Table status and game status are
--     independent with no cascade, so a seat can be claimed on a game that
--     is already 'cancelled' or 'completed' whenever its table row was left
--     open. (Both of those statuses exist in production data today.)
--
--  2. WAITLIST SELF-PROMOTION. The RSVP upsert ends with an unconditional
--     `SET response = 'yes'`. A player the host deliberately placed on
--     'waitlist' (or set to 'no') can click any empty seat and silently
--     overwrite the host's decision, promoting themselves into the game.
--     The host's own actions are the only thing that should move a player
--     off the waitlist.
--
--  3. RAW 23505 LEAKAGE. When the race guards above fire, the caller
--     receives a raw Postgres unique_violation naming the internal index.
--     The API layer has no domain error to map, so a lost seat race
--     surfaces as an opaque 500 instead of "that seat was just taken".
--
-- Everything else in the body is preserved byte-for-byte, including the
-- BUG-2 guest-name truncation.
--
-- Tier 3 (RPC behaviour change). ROLLBACK at the bottom.
-- =====================================================================

-- ---------- PRE-FLIGHT ----------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='rpc_hg_claim_seat'
          AND pg_get_function_identity_arguments(p.oid) = 'p_table_id uuid, p_seat_number integer, p_is_guest boolean'
    ) THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: rpc_hg_claim_seat(uuid,integer,boolean) not found - signature drift, do not blind-replace';
    END IF;

    -- The race-mapping below is only meaningful if the guards still exist.
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                   AND indexname='commander_home_seat_reservations_seat_lock') THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: seat_lock unique index missing - fix that before changing this RPC';
    END IF;
END $$;

-- ---------- APPLY ----------
CREATE OR REPLACE FUNCTION public.rpc_hg_claim_seat(
    p_table_id uuid,
    p_seat_number integer,
    p_is_guest boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id        uuid := auth.uid();
  v_table          RECORD;
  v_group_id       uuid;
  v_reservation_id uuid;
  v_caller_name    text;
  v_guest_name     text;
  v_existing_rsvp  text;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  -- Pull the parent game's status and capacity alongside the table.
  SELECT t.id, t.game_id, t.status, t.max_seats,
         g.group_id, g.status AS game_status
    INTO v_table
    FROM public.commander_home_game_tables t
    JOIN public.commander_home_games g ON g.id = t.game_id
   WHERE t.id = p_table_id;

  IF v_table.id IS NULL THEN RAISE EXCEPTION 'TABLE_NOT_FOUND'; END IF;

  -- FIX 1: the parent game must still be live. Table status alone is not
  -- sufficient - the two are independent enums with no cascade.
  IF v_table.game_status IS NOT NULL
     AND v_table.game_status IN ('cancelled','completed') THEN
    RAISE EXCEPTION 'GAME_NOT_ACTIVE' USING HINT = v_table.game_status;
  END IF;

  IF v_table.status <> 'open_for_rsvp' THEN
    RAISE EXCEPTION 'TABLE_NOT_OPEN' USING HINT = v_table.status;
  END IF;
  IF p_seat_number < 1 OR p_seat_number > v_table.max_seats THEN
    RAISE EXCEPTION 'SEAT_OUT_OF_BOUNDS';
  END IF;

  v_group_id := v_table.group_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.commander_home_members
     WHERE group_id = v_group_id AND user_id = v_user_id AND status = 'approved'
  ) AND NOT EXISTS (
    SELECT 1 FROM public.commander_home_groups
     WHERE id = v_group_id AND owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER';
  END IF;

  -- FIX 2: never let a seat claim overwrite a host-set waitlist/decline.
  SELECT response INTO v_existing_rsvp
    FROM public.commander_home_rsvps
   WHERE game_id = v_table.game_id AND user_id = v_user_id;

  IF v_existing_rsvp IN ('waitlist','no') THEN
    RAISE EXCEPTION 'WAITLISTED_CANNOT_SELF_SEAT' USING HINT = v_existing_rsvp;
  END IF;

  IF p_is_guest THEN
    -- BUG-2 fix: truncate caller display name so "{name} + Guest" never
    -- exceeds the 120-char guest_name CHECK constraint. 112 = 120 - 8
    -- (length of " + Guest").
    v_caller_name := LEFT(public.fn_hg_caller_display_name(v_user_id), 112);
    v_guest_name := v_caller_name || ' + Guest';
    BEGIN
      INSERT INTO public.commander_home_seat_reservations
        (table_id, seat_number, user_id, guest_name, is_guest, claimed_by_user_id, status)
      VALUES (p_table_id, p_seat_number, NULL, v_guest_name, true, v_user_id, 'reserved')
      RETURNING id INTO v_reservation_id;
    EXCEPTION WHEN unique_violation THEN
      -- FIX 3: map the storage-layer guards to domain errors.
      IF SQLERRM LIKE '%one_guest_per_user_per_table%' THEN
        RAISE EXCEPTION 'GUEST_ALREADY_CLAIMED';
      ELSE
        RAISE EXCEPTION 'SEAT_TAKEN';
      END IF;
    END;
  ELSE
    BEGIN
      INSERT INTO public.commander_home_seat_reservations
        (table_id, seat_number, user_id, is_guest, claimed_by_user_id, status)
      VALUES (p_table_id, p_seat_number, v_user_id, false, v_user_id, 'reserved')
      RETURNING id INTO v_reservation_id;
    EXCEPTION WHEN unique_violation THEN
      IF SQLERRM LIKE '%user_table_active%' THEN
        RAISE EXCEPTION 'ALREADY_AT_TABLE';
      ELSE
        RAISE EXCEPTION 'SEAT_TAKEN';
      END IF;
    END;

    INSERT INTO public.commander_home_rsvps
      (game_id, user_id, response, seat_number, is_confirmed, responded_at)
    VALUES (v_table.game_id, v_user_id, 'yes', p_seat_number, false, now())
    ON CONFLICT (game_id, user_id) DO UPDATE
      SET response = 'yes',
          seat_number = EXCLUDED.seat_number,
          responded_at = now(),
          updated_at = now()
      -- Belt-and-braces on FIX 2: even under a concurrent host update, never
      -- flip a waitlist/decline to 'yes' via this path.
      WHERE public.commander_home_rsvps.response NOT IN ('waitlist','no');
  END IF;

  RETURN v_reservation_id;
END $function$;

COMMENT ON FUNCTION public.rpc_hg_claim_seat(uuid,integer,boolean) IS
  'Claim a seat at a home game table. Guards: auth, parent game not cancelled/completed, table open_for_rsvp, seat in bounds, approved member or group owner, and refusal to self-promote off a host-set waitlist. Unique-index races are mapped to SEAT_TAKEN / ALREADY_AT_TABLE / GUEST_ALREADY_CLAIMED. See migration phase53.';

-- ---------- POST-APPLY ASSERTIONS ----------
DO $$
DECLARE v_src text;
BEGIN
    SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='rpc_hg_claim_seat';

    IF v_src NOT LIKE '%GAME_NOT_ACTIVE%'            THEN RAISE EXCEPTION 'POST-APPLY FAILED: game status guard missing'; END IF;
    IF v_src NOT LIKE '%WAITLISTED_CANNOT_SELF_SEAT%' THEN RAISE EXCEPTION 'POST-APPLY FAILED: waitlist guard missing'; END IF;
    IF v_src NOT LIKE '%SEAT_TAKEN%'                  THEN RAISE EXCEPTION 'POST-APPLY FAILED: race mapping missing'; END IF;
    IF v_src NOT LIKE '%fn_hg_caller_display_name%'   THEN RAISE EXCEPTION 'POST-APPLY FAILED: BUG-2 guest-name truncation was lost'; END IF;

    RAISE NOTICE 'phase53 OK: claim_seat hardened, prior fixes preserved.';
END $$;

-- =====================================================================
-- ROLLBACK: re-apply the previous definition, which is recorded verbatim in
-- the 2026-08-12 audit (audit-05-database.md) and retrievable via
--   SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='rpc_hg_claim_seat';
-- taken before this migration. Rolling back re-opens: seat claims on
-- cancelled games, waitlist self-promotion, and raw 23505 errors.
-- =====================================================================
