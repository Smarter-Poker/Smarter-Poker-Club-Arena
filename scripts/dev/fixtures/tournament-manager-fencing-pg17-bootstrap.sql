\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOLOGIN;
  END IF;
END;
$roles$;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$function$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  club_id uuid,
  union_id uuid,
  name text NOT NULL,
  game_type text,
  variant text,
  tournament_type text,
  buy_in_amount numeric NOT NULL DEFAULT 0,
  buy_in_fee numeric NOT NULL DEFAULT 0,
  guaranteed_prize numeric NOT NULL DEFAULT 0,
  starting_chips integer,
  max_players integer,
  min_players integer,
  table_size integer,
  current_players integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  blind_structure text,
  payout_structure text,
  start_time timestamptz,
  late_reg_levels integer NOT NULL DEFAULT 0,
  late_reg_mins integer NOT NULL DEFAULT 0,
  satellite_target_id uuid,
  satellite_seats integer,
  short_description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE,
  name text,
  game_type text,
  game_variant text,
  stakes text,
  small_blind numeric,
  big_blind numeric,
  min_buy_in numeric,
  max_buy_in numeric,
  status text NOT NULL,
  current_players integer NOT NULL DEFAULT 0,
  max_players integer NOT NULL DEFAULT 9,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen()
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$ SELECT false $function$;

/* Stage B must exercise the real compatibility-door retirement, even though
   this narrow fixture does not need the historical repair implementation. */
CREATE OR REPLACE FUNCTION public.fn_repair_seat_first_games(integer)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
AS $function$
  SELECT jsonb_build_object('repaired', 0, 'horses_seated', 0)
$function$;

CREATE OR REPLACE FUNCTION public.fn_repair_seat_first_games_before_maintenance_gate(integer)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
AS $function$
  SELECT jsonb_build_object('repaired', 0, 'horses_seated', 0)
$function$;

CREATE TABLE public.tournament_players (
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  status text NOT NULL,
  chips numeric NOT NULL DEFAULT 0,
  table_id uuid REFERENCES public.tables(id) ON DELETE SET NULL,
  seat_number integer,
  PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE public.table_seats (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  user_id uuid,
  seat_number integer NOT NULL,
  stack numeric NOT NULL DEFAULT 0,
  left_at timestamptz,
  PRIMARY KEY (table_id, seat_number)
);

CREATE TABLE public.tournament_launch_receipts (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  launch_id uuid NOT NULL UNIQUE,
  lease_generation uuid NOT NULL,
  started_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz
);

CREATE TABLE public.tournament_capacity_table_receipts (
  table_id uuid PRIMARY KEY REFERENCES public.tables(id) ON DELETE CASCADE,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE
);

CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 2 CHECK (protocol_version IN (1, 2))
);

CREATE TABLE public.engine_table_leases (
  table_id uuid PRIMARY KEY REFERENCES public.tables(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 2 CHECK (protocol_version IN (1, 2))
);

CREATE OR REPLACE FUNCTION public.trg_one_live_seat_fixture()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_one_live_seat_per_tournament
  BEFORE INSERT OR UPDATE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.trg_one_live_seat_fixture();

/* The launch-child migration asserts that the canonical capacity function
   creates a table before its same-transaction receipt. The probe never calls
   this minimal fixture implementation. */
CREATE OR REPLACE FUNCTION public.fn_ensure_late_registration_capacity(
  p_tournament_id uuid,
  p_required_seats integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_table_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.tables (
    id, tournament_id, status, current_players, max_players
  ) VALUES (
    v_table_id, p_tournament_id, 'waiting', 0, greatest(p_required_seats, 1)
  );
  INSERT INTO public.tournament_capacity_table_receipts (
    table_id, tournament_id
  ) VALUES (
    v_table_id, p_tournament_id
  );
  RETURN jsonb_build_object('ok', true, 'table_id', v_table_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_tournament_lease(
  uuid, text, text, integer
) RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT false, NULL::text, NULL::numeric $function$;

CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v2(
  text, uuid[], integer
) RETURNS TABLE(tournament_id uuid, state text)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid, NULL::text WHERE false $function$;

CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases(
  text, uuid[]
) RETURNS TABLE(tournament_id uuid)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid WHERE false $function$;

CREATE OR REPLACE FUNCTION public.release_tournament_leases(
  text, uuid[]
) RETURNS integer
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT 0 $function$;

CREATE OR REPLACE FUNCTION public.claim_tournament_lease_v2(
  uuid, text, text, uuid, integer
) RETURNS TABLE(
  granted boolean,
  holder text,
  holder_age_seconds numeric,
  lease_generation uuid,
  protocol_version integer
)
LANGUAGE sql SECURITY DEFINER
AS $function$
  SELECT false, NULL::text, NULL::numeric, NULL::uuid, 2
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v3(
  text, jsonb, integer
) RETURNS TABLE(tournament_id uuid, state text, lease_generation uuid)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid, NULL::text, NULL::uuid WHERE false $function$;

CREATE OR REPLACE FUNCTION public.release_tournament_leases_v2(
  text, jsonb
) RETURNS integer
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT 0 $function$;

CREATE OR REPLACE FUNCTION public.claim_table_lease(
  uuid, text, text, integer
) RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT false, NULL::text, NULL::numeric $function$;

CREATE OR REPLACE FUNCTION public.heartbeat_table_leases_v2(
  text, uuid[], integer
) RETURNS TABLE(table_id uuid, state text)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid, NULL::text WHERE false $function$;

CREATE OR REPLACE FUNCTION public.heartbeat_table_leases(
  text, uuid[]
) RETURNS TABLE(table_id uuid)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid WHERE false $function$;

CREATE OR REPLACE FUNCTION public.release_table_leases(
  text, uuid[]
) RETURNS integer
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT 0 $function$;

CREATE OR REPLACE FUNCTION public.claim_table_lease_v2(
  uuid, text, text, uuid, integer
) RETURNS TABLE(
  granted boolean,
  holder text,
  holder_age_seconds numeric,
  lease_generation uuid,
  protocol_version integer
)
LANGUAGE sql SECURITY DEFINER
AS $function$
  SELECT false, NULL::text, NULL::numeric, NULL::uuid, 2
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_table_leases_v3(
  text, jsonb, integer
) RETURNS TABLE(table_id uuid, state text, lease_generation uuid)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid, NULL::text, NULL::uuid WHERE false $function$;

CREATE OR REPLACE FUNCTION public.release_table_leases_v2(
  text, jsonb
) RETURNS integer
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT 0 $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('success', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('success', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('success', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid,
  jsonb
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$
  SELECT public.fn_ca_commit_hand_settlement_exact_before_obligations(
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
  ) || jsonb_build_object('post_commit_obligations', true)
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_process_hand_post_commit_obligations(
  uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('success', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('ok', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(
  uuid, uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('ok', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('ok', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(
  uuid, uuid, uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('ok', true) $function$;

INSERT INTO public.tournaments (id, name, status) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Fence A', 'RUNNING'),
  ('10000000-0000-4000-8000-000000000002', 'Fence B', 'RUNNING');

INSERT INTO public.tables (
  id, tournament_id, status, current_players, max_players
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'running', 0, 9
);

INSERT INTO public.tables (
  id, tournament_id, status, current_players, max_players
) VALUES (
  '20000000-0000-4000-8000-000000000002',
  NULL,
  'running', 0, 9
);

INSERT INTO public.tournament_players (
  tournament_id, user_id, status, chips, table_id, seat_number
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'registered', 1000,
  '20000000-0000-4000-8000-000000000001', 1
);

INSERT INTO public.tournament_launch_receipts (
  tournament_id, launch_id, lease_generation, started_at, completed_at
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  clock_timestamp() - interval '1 hour',
  clock_timestamp() - interval '59 minutes'
);

INSERT INTO public.engine_tournament_leases (
  tournament_id, instance_id, engine_version, heartbeat_at,
  lease_generation, protocol_version
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  'pg17-probe', 'probe', clock_timestamp(),
  '50000000-0000-4000-8000-000000000001', 2
);

INSERT INTO public.engine_table_leases (
  table_id, instance_id, engine_version, heartbeat_at,
  lease_generation, protocol_version
) VALUES (
  '20000000-0000-4000-8000-000000000002',
  'pg17-probe', 'probe', clock_timestamp(),
  '60000000-0000-4000-8000-000000000001', 2
);
