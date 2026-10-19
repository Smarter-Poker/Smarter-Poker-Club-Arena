-- Minimal fixture reproducing only what smarter_private.f06_source_guard()
-- reads: public.tables/table_seats/tournament_players and the smarter_private
-- F06 bookkeeping tables it joins against. Not the real schema - just enough
-- surface for the trigger body to execute unchanged.
CREATE SCHEMA IF NOT EXISTS smarter_private;

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  tournament_id uuid
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY,
  table_id uuid REFERENCES public.tables(id),
  user_id uuid,
  seat_number int,
  left_at timestamptz,
  stack numeric,
  status text,
  joined_at timestamptz,
  club_id uuid,
  leave_pending boolean DEFAULT false,
  is_sitting_out boolean DEFAULT false,
  is_away boolean DEFAULT false,
  sit_out_at timestamptz,
  scheduled_leave_hands int
);

CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY,
  tournament_id uuid,
  user_id uuid,
  table_id uuid,
  seat_number int,
  status text,
  chips numeric,
  position int,
  eliminated_at timestamptz,
  elimination_sequence bigint
);

CREATE TABLE public.tournament_knockout_candidates (
  id uuid PRIMARY KEY,
  tournament_id uuid,
  table_id uuid,
  eliminated_user_id uuid,
  state text,
  stack_after numeric,
  seat_id uuid,
  seat_joined_at timestamptz
);

CREATE TABLE smarter_private.f06_operations (
  break_id uuid PRIMARY KEY,
  ordinal int,
  tournament_id uuid,
  source_table_id uuid,
  lifecycle bigint,
  boundary_id uuid,
  origin_generation uuid,
  state text,
  manifest jsonb,
  revision int,
  custody_id uuid,
  custody_generation uuid,
  cleanup_kind text,
  close_receipt jsonb,
  created_at timestamptz DEFAULT now(),
  abort_receipt_id uuid
);

CREATE TABLE smarter_private.f06_movement_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  break_id uuid
);
CREATE TABLE smarter_private.f06_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  break_id uuid
);
CREATE TABLE smarter_private.f06_attempts (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  break_id uuid,
  user_id uuid,
  destination_table_id uuid,
  destination_seat_number int,
  state text
);
CREATE TABLE smarter_private.f06_dispatch (
  request_id uuid PRIMARY KEY,
  xid bigint
);
CREATE TABLE smarter_private.f06_hand_permits (
  permit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid
);
CREATE TABLE smarter_private.f06_hand_dispatch (
  permit_id uuid PRIMARY KEY,
  xid bigint
);
CREATE TABLE smarter_private.f06_elimination_dispatch (
  xid bigint,
  relation_name text,
  row_id uuid,
  candidate_id uuid,
  old_record jsonb,
  new_record jsonb
);

-- Real f06_try_lane takes real advisory locks this fixture has no contenders
-- for; stub it so the guard's own lane acquisition step is a no-op here.
CREATE OR REPLACE FUNCTION smarter_private.f06_try_lane(uuid) RETURNS void
LANGUAGE sql AS $$ SELECT NULL::void $$;
