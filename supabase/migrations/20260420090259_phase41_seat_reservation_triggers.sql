-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420090259 "phase41_seat_reservation_triggers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6a7bb5116a987a270baccd86df74b3c2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 41 Part D: business-rule triggers on commander_home_seat_reservations.
-- Mirrors the fn_enforce_rsvp_deadline service-role-bypass pattern.

-- ============================================================================
-- 1) Deadline + status gate
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_enforce_seat_reservation_deadline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_table RECORD;
  v_game  RECORD;
  v_cutoff timestamptz;
BEGIN
  -- Service-role bypass (server-side API routes use the service-role client,
  -- and enforce these checks themselves at the API layer). Matches the
  -- existing fn_enforce_rsvp_deadline pattern.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  -- On UPDATE, only re-validate when status is transitioning to/from an active
  -- state. Pure non-status updates (e.g., note) don't need the gate.
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Only gate INSERTs and transitions INTO an active-claim state.
  IF TG_OP = 'INSERT' OR NEW.status IN ('reserved','seated') THEN
    SELECT id, game_id, status, max_seats
      INTO v_table
      FROM public.commander_home_game_tables
     WHERE id = NEW.table_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'TABLE_NOT_FOUND' USING HINT = 'table_id does not exist';
    END IF;

    IF v_table.status = 'cancelled' THEN
      RAISE EXCEPTION 'TABLE_CANCELLED';
    END IF;
    IF v_table.status = 'ended' THEN
      RAISE EXCEPTION 'TABLE_ENDED';
    END IF;
    IF v_table.status = 'running' THEN
      -- Per Dan's spec #5: once a table is running, live seating is owned by
      -- Commander (commander_home_seats), not by this reservations table.
      RAISE EXCEPTION 'TABLE_RUNNING'
        USING HINT = 'once a table is running, seating is managed via Club Commander';
    END IF;
    IF v_table.status = 'draft' THEN
      RAISE EXCEPTION 'TABLE_NOT_OPEN_FOR_RSVP'
        USING HINT = 'host has not opened this table for RSVPs yet';
    END IF;

    -- Seat number must be within the table's declared capacity.
    IF NEW.seat_number > v_table.max_seats THEN
      RAISE EXCEPTION 'SEAT_OUT_OF_BOUNDS'
        USING HINT = format('seat %s exceeds table max_seats %s',
                             NEW.seat_number, v_table.max_seats);
    END IF;

    SELECT id, status, rsvps_closed, rsvp_closes_at,
           scheduled_date, start_time, cancelled_at
      INTO v_game
      FROM public.commander_home_games
     WHERE id = v_table.game_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    IF v_game.cancelled_at IS NOT NULL OR v_game.status = 'cancelled' THEN
      RAISE EXCEPTION 'GAME_CANCELLED';
    END IF;
    IF v_game.rsvps_closed = true THEN
      RAISE EXCEPTION 'RSVPS_CLOSED'
        USING HINT = 'host has closed RSVPs for this game';
    END IF;
    IF v_game.rsvp_closes_at IS NOT NULL AND v_game.rsvp_closes_at < now() THEN
      RAISE EXCEPTION 'RSVP_DEADLINE_PASSED'
        USING HINT = 'RSVP deadline was ' || v_game.rsvp_closes_at::text;
    END IF;

    -- Dan's product answer #6: scheduled_date + start_time is the HARD cutoff.
    IF v_game.scheduled_date IS NOT NULL AND v_game.start_time IS NOT NULL THEN
      v_cutoff := (v_game.scheduled_date + v_game.start_time)::timestamptz;
      IF v_cutoff < now() THEN
        RAISE EXCEPTION 'GAME_START_TIME_PASSED'
          USING HINT = 'game started at ' || v_cutoff::text
                    || '; live seating is owned by Club Commander after start';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_seat_reservation_deadline
  ON public.commander_home_seat_reservations;
CREATE TRIGGER trg_enforce_seat_reservation_deadline
  BEFORE INSERT OR UPDATE ON public.commander_home_seat_reservations
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_seat_reservation_deadline();

-- ============================================================================
-- 2) One guest seat per user per table (Dan's answer #3)
--    Enforced at DB level via partial unique index.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS commander_home_seat_reservations_one_guest_per_user_per_table
  ON public.commander_home_seat_reservations (table_id, claimed_by_user_id)
  WHERE is_guest = true AND status IN ('reserved','seated');

-- ============================================================================
-- 3) Group activity bump on reservation changes
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_bump_group_activity_on_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT g.group_id INTO v_group_id
    FROM public.commander_home_game_tables t
    JOIN public.commander_home_games g ON g.id = t.game_id
   WHERE t.id = COALESCE(NEW.table_id, OLD.table_id);

  IF v_group_id IS NOT NULL THEN
    UPDATE public.commander_home_groups
       SET last_activity_at = now()
     WHERE id = v_group_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_bump_group_activity_on_reservation
  ON public.commander_home_seat_reservations;
CREATE TRIGGER trg_bump_group_activity_on_reservation
  AFTER INSERT OR UPDATE OR DELETE ON public.commander_home_seat_reservations
  FOR EACH ROW EXECUTE FUNCTION public.fn_bump_group_activity_on_reservation();

-- ============================================================================
-- 4) Keep one-default-table invariant
--    If someone tries to delete the default table while others exist,
--    reject. They must promote another table to default first.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_protect_default_table()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_other_count int;
BEGIN
  IF OLD.is_default = true THEN
    SELECT count(*) INTO v_other_count
      FROM public.commander_home_game_tables
     WHERE game_id = OLD.game_id AND id <> OLD.id;
    IF v_other_count > 0 THEN
      RAISE EXCEPTION 'CANNOT_DELETE_DEFAULT_TABLE_WITH_SIBLINGS'
        USING HINT = 'promote another table to default before deleting this one';
    END IF;
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_protect_default_table
  ON public.commander_home_game_tables;
CREATE TRIGGER trg_protect_default_table
  BEFORE DELETE ON public.commander_home_game_tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_default_table();
