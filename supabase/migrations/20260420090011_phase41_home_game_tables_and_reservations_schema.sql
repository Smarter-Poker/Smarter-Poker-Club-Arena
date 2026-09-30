-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420090011 "phase41_home_game_tables_and_reservations_schema"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 84f2681dd3dd12aa314bbc21b78bb58c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 41: multi-table seat-reservation schema
-- Part A: create commander_home_game_tables + commander_home_seat_reservations
-- Model: event (commander_home_games) 1:N tables 1:N reservations

-- ============================================================================
-- 1) commander_home_game_tables — a table running at an event
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.commander_home_game_tables (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id          uuid NOT NULL REFERENCES public.commander_home_games(id) ON DELETE CASCADE,
  table_number     integer NOT NULL,
  name             text,
  game_type        text NOT NULL DEFAULT 'NLH',
  stakes           text,
  format           text NOT NULL DEFAULT 'cash'
                     CHECK (format IN ('cash','tournament','sitngo','mixed')),
  buyin_min        integer,
  buyin_max        integer,
  max_seats        integer NOT NULL DEFAULT 9
                     CHECK (max_seats >= 2 AND max_seats <= 10),
  status           text NOT NULL DEFAULT 'open_for_rsvp'
                     CHECK (status IN ('draft','open_for_rsvp','running','ended','cancelled')),
  is_default       boolean NOT NULL DEFAULT false,
  started_at       timestamptz,
  ended_at         timestamptz,
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commander_home_game_tables_number_per_game UNIQUE (game_id, table_number),
  CONSTRAINT commander_home_game_tables_buyin_range_ok
    CHECK (buyin_min IS NULL OR buyin_max IS NULL OR buyin_min <= buyin_max)
);

COMMENT ON TABLE public.commander_home_game_tables IS
  'Phase 41: individual tables running at a home-game event. An event has 1..N tables, each with its own game_type/stakes/seats.';
COMMENT ON COLUMN public.commander_home_game_tables.is_default IS
  'True for the auto-provisioned first table of an event (inherits event-level game_type/stakes).';
COMMENT ON COLUMN public.commander_home_game_tables.status IS
  'draft (host still configuring) | open_for_rsvp (players can claim seats) | running (game live, managed via Commander) | ended | cancelled';

-- Exactly one default table per event
CREATE UNIQUE INDEX IF NOT EXISTS commander_home_game_tables_one_default_per_game
  ON public.commander_home_game_tables (game_id)
  WHERE is_default = true;

CREATE INDEX IF NOT EXISTS commander_home_game_tables_game_id_idx
  ON public.commander_home_game_tables (game_id);

CREATE INDEX IF NOT EXISTS commander_home_game_tables_status_idx
  ON public.commander_home_game_tables (status)
  WHERE status IN ('open_for_rsvp','running');

-- ============================================================================
-- 2) commander_home_seat_reservations — pre-game seat locks
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.commander_home_seat_reservations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id              uuid NOT NULL REFERENCES public.commander_home_game_tables(id) ON DELETE CASCADE,
  seat_number           integer NOT NULL CHECK (seat_number >= 1 AND seat_number <= 10),
  -- Identity: EITHER a Smarter.Poker user (user_id) OR a named non-user (guest_name)
  user_id               uuid REFERENCES auth.users(id),
  member_id             uuid REFERENCES public.commander_home_members(id),
  guest_name            text,
  is_guest              boolean NOT NULL DEFAULT false,
  -- Who submitted the claim (for host-claims-on-behalf-of-member)
  claimed_by_user_id    uuid NOT NULL REFERENCES auth.users(id),
  status                text NOT NULL DEFAULT 'reserved'
                          CHECK (status IN ('reserved','seated','released','no_show','cancelled')),
  claimed_at            timestamptz NOT NULL DEFAULT now(),
  seated_at             timestamptz,
  released_at           timestamptz,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commander_home_seat_reservations_identity_check
    CHECK (user_id IS NOT NULL OR guest_name IS NOT NULL),
  CONSTRAINT commander_home_seat_reservations_guest_name_len
    CHECK (guest_name IS NULL OR (char_length(guest_name) BETWEEN 1 AND 120))
);

COMMENT ON TABLE public.commander_home_seat_reservations IS
  'Phase 41: seat-level pre-game claims. First-come-first-serve via partial unique index on (table_id, seat_number) WHERE status IN (reserved, seated). Post-start, Commander owns live seating.';

-- Hard seat lock: at most one active claim per (table, seat)
CREATE UNIQUE INDEX IF NOT EXISTS commander_home_seat_reservations_seat_lock
  ON public.commander_home_seat_reservations (table_id, seat_number)
  WHERE status IN ('reserved','seated');

-- At most one active reservation per user per table (prevents a user locking 2 seats except via the guest workflow)
CREATE UNIQUE INDEX IF NOT EXISTS commander_home_seat_reservations_user_table_active
  ON public.commander_home_seat_reservations (table_id, user_id)
  WHERE status IN ('reserved','seated') AND user_id IS NOT NULL AND is_guest = false;

CREATE INDEX IF NOT EXISTS commander_home_seat_reservations_user_id_idx
  ON public.commander_home_seat_reservations (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commander_home_seat_reservations_table_id_idx
  ON public.commander_home_seat_reservations (table_id);

-- ============================================================================
-- 3) Repurpose commander_home_seats as live-seating (Commander/tablet view)
-- ============================================================================
ALTER TABLE public.commander_home_seats
  ADD COLUMN IF NOT EXISTS table_id uuid REFERENCES public.commander_home_game_tables(id) ON DELETE CASCADE;

ALTER TABLE public.commander_home_seats
  ADD COLUMN IF NOT EXISTS reservation_id uuid REFERENCES public.commander_home_seat_reservations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS commander_home_seats_table_id_idx
  ON public.commander_home_seats (table_id);

-- ============================================================================
-- 4) updated_at maintenance
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_touch_updated_at ON public.commander_home_game_tables;
CREATE TRIGGER trg_touch_updated_at
  BEFORE UPDATE ON public.commander_home_game_tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON public.commander_home_seat_reservations;
CREATE TRIGGER trg_touch_updated_at
  BEFORE UPDATE ON public.commander_home_seat_reservations
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();
