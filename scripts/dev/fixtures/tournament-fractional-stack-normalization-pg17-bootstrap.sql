\set ON_ERROR_STOP on

CREATE SCHEMA realtime;
CREATE TABLE realtime.subscription (id bigint PRIMARY KEY);

CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[],
  name text
);
/* Production apply_migration records wall-clock versions, not repository file
   timestamps. Deliberately make all four differ so the cutover can only rely
   on the exact migration names plus the live source/ACL invariants. */
INSERT INTO supabase_migrations.schema_migrations(version, name)
VALUES
  ('20260908161534', 'hand_settlement_targets_exact_seat_generation'),
  ('20260908162211', 'tournament_manager_request_fencing_is_strict'),
  ('20260908162847', 'hand_settlement_requires_exact_seat_generation'),
  ('20260908163409', 'tournament_seat_moves_are_one_atomic_receipt');

CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$roles$;

CREATE TABLE public.engine_maintenance_break (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  phase text NOT NULL,
  announced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  break_started_at timestamptz,
  break_ends_at timestamptz,
  reason text NOT NULL DEFAULT 'Probe',
  declared_by text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  enforce_freeze boolean NOT NULL DEFAULT false
);

CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.engine_maintenance_break b
     WHERE b.id AND b.phase = 'counting_down' AND b.enforce_freeze
       AND b.break_ends_at > now()
       AND b.break_ends_at < now() + interval '15 minutes'
  );
$function$;

CREATE TABLE public.engine_leader (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  starting_chips integer NOT NULL,
  rebuy_chips integer,
  addon_chips integer,
  blind_structure text,
  current_level integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  tournament_id uuid REFERENCES public.tournaments(id),
  game_type text NOT NULL DEFAULT 'tournament',
  status text NOT NULL,
  small_blind numeric(15,2) NOT NULL,
  big_blind numeric(15,2) NOT NULL,
  ante numeric(15,2),
  bomb_pot_enabled boolean NOT NULL DEFAULT false,
  bomb_pot_ante_multiplier integer NOT NULL DEFAULT 2,
  bomb_pot_ante_fixed numeric,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES public.tables(id),
  seat_number integer NOT NULL,
  user_id uuid,
  stack numeric(15,2),
  is_sitting_out boolean NOT NULL DEFAULT false,
  joined_at timestamptz,
  left_at timestamptz,
  UNIQUE (table_id, seat_number)
);

CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL,
  chips integer,
  status text NOT NULL,
  table_id uuid REFERENCES public.tables(id),
  seat_number integer,
  registered_at timestamptz NOT NULL,
  UNIQUE (tournament_id, user_id)
);

/* The real DB-first atomic-move migration has already run before this fixture's
   normalization window. Its implementation is covered by the dedicated seat-
   move PG17 probe; this fixture preserves the exact catalog prerequisites that
   normalization must refuse to run without. */
CREATE UNIQUE INDEX idx_tournament_players_one_active_destination_pointer
  ON public.tournament_players (tournament_id, table_id, seat_number)
  WHERE status IN ('registered', 'playing')
    AND table_id IS NOT NULL
    AND seat_number IS NOT NULL;

CREATE TABLE public.tournament_seat_move_receipts (
  operation_id uuid PRIMARY KEY
);

CREATE OR REPLACE FUNCTION public.fn_move_tournament_player_atomic(
  p_operation_id uuid,
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid,
  p_source_seat_number integer,
  p_source_seat_id uuid,
  p_source_joined_at timestamptz,
  p_expected_stack bigint,
  p_destination_table_id uuid,
  p_destination_seat_number integer
) RETURNS jsonb
LANGUAGE sql
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object('ok', false, 'reason', 'fixture_not_invoked');
$function$;

CREATE TABLE public.tournament_flights (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL,
  bagged_chips integer NOT NULL DEFAULT 0
);

CREATE TABLE public.engine_table_leases (
  table_id uuid PRIMARY KEY REFERENCES public.tables(id),
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  lease_generation uuid NOT NULL,
  protocol_version integer NOT NULL
);

CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  lease_generation uuid NOT NULL,
  protocol_version integer NOT NULL
);

CREATE TABLE public.hand_state_snapshots (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES public.tables(id),
  hand_number bigint NOT NULL,
  is_complete boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.settlement_idempotency_keys (
  table_id uuid NOT NULL REFERENCES public.tables(id),
  hand_id uuid NOT NULL,
  status text NOT NULL,
  first_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, hand_id)
);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL REFERENCES public.tables(id),
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL,
  post_commit_payload jsonb,
  post_commit_completed_at timestamptz,
  PRIMARY KEY (table_id, hand_number)
);

CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  p_table_id uuid, p_hand_number bigint, p_stacks jsonb,
  p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION
    'Exact seat generation is required for every hand settlement participant';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  p_table_id uuid, p_hand_number bigint, p_stacks jsonb,
  p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric,
  p_hand_row jsonb, p_units jsonb, p_instance_id text,
  p_lease_generation uuid, p_post_commit_obligations jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  x jsonb;
  v_written numeric := 0;
BEGIN
  -- exact_stack_seat_generation_required
  -- exact_time_bank_seat_generation_required
  SELECT count(*)
    FROM jsonb_array_elements(p_stacks) x
   WHERE jsonb_typeof(x)='object'
     AND jsonb_typeof(x->'stack')='number'
     AND jsonb_typeof(x->'stack_before')='number'
     AND (x->>'stack')::numeric>=0
     AND (x->>'stack_before')::numeric>=0;
  IF v_written<>trunc(v_written) THEN
    RAISE EXCEPTION 'accepted tournament hand produced fractional stack';
  END IF;
  UPDATE public.tournament_players
     SET chips=greatest(v_written,0)::integer
   WHERE false;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players
     WHERE false AND chips=greatest(v_written,0)::integer
  ) THEN
    RAISE EXCEPTION 'unreachable';
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(
  uuid,bigint,jsonb,numeric,numeric,text,numeric
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb
) TO service_role;

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy_before_atomic_live_seat_lock(
  p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric,
  p_chips numeric, p_current_level integer, p_client_token text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_p record;
  v_seat record;
  v_add integer; v_new_chips integer;
  v_legacy_ratio numeric;
BEGIN
  v_add := COALESCE(p_chips, 0)::integer;
  v_add := COALESCE(p_chips, 0)::integer;
  v_legacy_ratio := CASE WHEN p_cost IS NULL THEN 0 ELSE 1 END;
  UPDATE tournament_players
     SET chips=(SELECT stack FROM table_seats WHERE id=v_seat.id)::integer
   WHERE false
   RETURNING chips INTO v_new_chips;
  RETURN jsonb_build_object('success', true, 'new_stack', v_new_chips);
END;
$function$;

CREATE OR REPLACE FUNCTION public.probe_freeze_stack_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.stack IS DISTINCT FROM OLD.stack
     AND public.fn_platform_frozen()
     AND COALESCE(current_setting('app.freeze_bypass', true), '') <> 'on' THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN probe stack write refused';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER zz_freeze_guard
  BEFORE UPDATE OF stack ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.probe_freeze_stack_write();

CREATE OR REPLACE FUNCTION public.probe_write_tournament_stack(
  p_seat_id uuid,
  p_stack numeric
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  UPDATE public.table_seats SET stack = p_stack WHERE id = p_seat_id;
$function$;
REVOKE ALL ON FUNCTION public.probe_write_tournament_stack(uuid,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.probe_write_tournament_stack(uuid,numeric)
  TO service_role;

/* Exact legacy production shape: ordered, but silently floors fractional
   payloads. The migration must replace this runtime ingress in place while
   retaining its engine-only authority. */
CREATE OR REPLACE FUNCTION public.fn_sync_tournament_chips(
  p_tournament_id uuid,
  p_updates jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF p_tournament_id IS NULL OR p_updates IS NULL
     OR jsonb_typeof(p_updates) <> 'array' THEN
    RETURN 0;
  END IF;
  PERFORM 1
    FROM public.tournament_players tp
    JOIN jsonb_to_recordset(p_updates) AS u(user_id uuid, chips numeric)
      ON u.user_id = tp.user_id
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'playing'
     AND tp.chips IS DISTINCT FROM floor(GREATEST(u.chips, 0))::integer
   ORDER BY tp.user_id
   FOR UPDATE OF tp;
  UPDATE public.tournament_players tp
     SET chips = floor(GREATEST(u.chips, 0))::integer
    FROM jsonb_to_recordset(p_updates) AS u(user_id uuid, chips numeric)
   WHERE tp.tournament_id = p_tournament_id
     AND tp.user_id = u.user_id
     AND tp.status = 'playing'
     AND tp.chips IS DISTINCT FROM floor(GREATEST(u.chips, 0))::integer;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_sync_tournament_chips(uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_tournament_chips(uuid,jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_sync_tournament_live_seat_chips(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_updates jsonb;
  v_open_user_ids jsonb;
  v_ambiguous_user_ids jsonb;
  v_synced integer;
BEGIN
  WITH live AS (
    SELECT s.user_id, s.stack, s.joined_at
      FROM public.tables t
      JOIN public.table_seats s ON s.table_id = t.id AND s.left_at IS NULL
     WHERE t.tournament_id = p_tournament_id
  ), latest AS (
    SELECT user_id, max(joined_at) AS latest_joined_at
      FROM live GROUP BY user_id
  ), classified AS (
    SELECT l.user_id, m.latest_joined_at,
           count(*) FILTER (WHERE l.joined_at = m.latest_joined_at) AS latest_count,
           max(l.stack) FILTER (WHERE l.joined_at = m.latest_joined_at) AS latest_stack
      FROM live l JOIN latest m USING (user_id)
     GROUP BY l.user_id, m.latest_joined_at
  )
  SELECT COALESCE(jsonb_agg(DISTINCT user_id ORDER BY user_id), '[]'::jsonb),
         COALESCE(jsonb_agg(user_id ORDER BY user_id) FILTER (
           WHERE latest_joined_at IS NULL OR latest_count <> 1), '[]'::jsonb),
         COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', user_id,
           'chips', floor(GREATEST(COALESCE(latest_stack,0),0))
         ) ORDER BY user_id) FILTER (
           WHERE latest_joined_at IS NOT NULL AND latest_count = 1), '[]'::jsonb)
    INTO v_open_user_ids, v_ambiguous_user_ids, v_updates
    FROM classified;
  v_synced := public.fn_sync_tournament_chips(p_tournament_id, v_updates);
  RETURN jsonb_build_object(
    'ok', true, 'synced', COALESCE(v_synced, 0),
    'open_user_ids', v_open_user_ids,
    'ambiguous_user_ids', v_ambiguous_user_ids
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_sync_tournament_live_seat_chips(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_tournament_live_seat_chips(uuid)
  TO service_role;

INSERT INTO public.engine_maintenance_break(
  id, phase, announced_at, break_started_at, break_ends_at,
  declared_by, enforce_freeze
) VALUES (
  true, 'counting_down', clock_timestamp() - interval '1 minute',
  clock_timestamp() - interval '30 seconds',
  clock_timestamp() + interval '10 minutes', 'deadbeef', true
);

INSERT INTO public.tournaments(
  id, name, status, starting_chips, rebuy_chips, addon_chips,
  blind_structure, created_at
) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Remainder A', 'RUNNING', 100, 100, 100,
   '[{"level":1,"smallBlind":1,"bigBlind":2,"ante":0}]', '2026-09-08 15:00:00+00'),
  ('00000000-0000-0000-0000-000000000002', 'Stable Tie B', 'REGISTERING', 100, 100, 100,
   '[{"level":1,"smallBlind":2,"bigBlind":4,"ante":1},{"isBreak":true,"smallBlind":0.5,"bigBlind":0.5,"ante":0.5}]', '2026-09-08 15:01:00+00'),
  ('00000000-0000-0000-0000-000000000003', 'Completed Testimony', 'COMPLETED', 10, 10, 10,
   '[{"level":1,"smallBlind":1,"bigBlind":2,"ante":0}]', '2026-09-01 15:00:00+00'),
  ('00000000-0000-0000-0000-000000000004', 'Cancelled Testimony', 'CANCELLED', 10, 10, 10,
   '[{"level":1,"smallBlind":1,"bigBlind":2,"ante":0}]', '2026-09-01 16:00:00+00');

INSERT INTO public.tables(
  id, tournament_id, game_type, status, small_blind, big_blind, ante,
  bomb_pot_enabled, bomb_pot_ante_fixed, created_at
) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'tournament', 'running', 1, 2, 0, true, 3, '2026-09-08 15:00:00+00'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'tournament', 'running', 2, 4, 1, false, NULL, '2026-09-08 15:01:00+00'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'tournament', 'running', 2, 4, 1, true, 5, '2026-09-08 15:01:01+00'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 'tournament', 'closed', 1, 2, 0, false, 0.75, '2026-09-01 15:00:00+00'),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000004', 'tournament', 'closed', 1, 2, 0, false, NULL, '2026-09-01 16:00:00+00'),
  ('10000000-0000-0000-0000-000000000006', NULL, 'cash', 'running', 0.25, 0.50, 0.10, true, 0.25, '2026-09-08 15:02:00+00');

INSERT INTO public.table_seats(
  id, table_id, seat_number, user_id, stack, joined_at, left_at
) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 1, '30000000-0000-0000-0000-000000000001', 33.34, '2026-09-08 15:10:01+00', NULL),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 2, '30000000-0000-0000-0000-000000000002', 33.33, '2026-09-08 15:10:02+00', NULL),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 3, '30000000-0000-0000-0000-000000000003', 33.33, '2026-09-08 15:10:03+00', NULL),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 1, '30000000-0000-0000-0000-000000000004', 50.50, '2026-09-08 15:11:01+00', NULL),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000003', 1, '30000000-0000-0000-0000-000000000005', 49.50, '2026-09-08 15:11:02+00', NULL),
  ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000004', 1, '30000000-0000-0000-0000-000000000006', 9.50, '2026-09-01 15:10:01+00', NULL),
  ('20000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000005', 1, '30000000-0000-0000-0000-000000000007', 8.75, '2026-09-01 16:10:01+00', NULL),
  ('20000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000006', 1, '30000000-0000-0000-0000-000000000008', 12.34, '2026-09-08 15:12:01+00', NULL),
  ('20000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000004', 2, '30000000-0000-0000-0000-000000000009', 7.25, '2026-09-01 15:10:02+00', '2026-09-01 15:20:02+00');

INSERT INTO public.tournament_players(
  id, tournament_id, user_id, chips, status, table_id, seat_number, registered_at
) VALUES
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 33, 'playing', '10000000-0000-0000-0000-000000000001', 1, '2026-09-08 14:00:01+00'),
  ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 33, 'playing', '10000000-0000-0000-0000-000000000001', 2, '2026-09-08 14:00:02+00'),
  ('40000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 33, 'playing', '10000000-0000-0000-0000-000000000001', 3, '2026-09-08 14:00:03+00'),
  ('40000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000004', 50, 'registered', '10000000-0000-0000-0000-000000000002', 1, '2026-09-08 14:01:01+00'),
  ('40000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000005', 49, 'registered', '10000000-0000-0000-0000-000000000003', 1, '2026-09-08 14:01:02+00'),
  ('40000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000006', 9, 'playing', '10000000-0000-0000-0000-000000000004', 1, '2026-09-01 14:00:01+00'),
  ('40000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000007', 8, 'playing', '10000000-0000-0000-0000-000000000005', 1, '2026-09-01 14:01:01+00'),
  ('40000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000010', 0, 'eliminated', NULL, NULL, '2026-09-01 13:00:00+00');

INSERT INTO public.engine_leader(
  id, instance_id, engine_version, acquired_at, heartbeat_at
) VALUES (true, 'stopped-probe', 'deadbeef', clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '2 minutes');

INSERT INTO public.engine_table_leases(
  table_id, instance_id, engine_version, acquired_at, heartbeat_at,
  lease_generation, protocol_version
)
SELECT t.id, 'stopped-probe', 'deadbeef',
       clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '2 minutes',
       ('50000000-0000-0000-0000-' || lpad(row_number() OVER (ORDER BY t.id)::text, 12, '0'))::uuid,
       2
  FROM public.tables t;

INSERT INTO public.engine_tournament_leases(
  tournament_id, instance_id, engine_version, acquired_at, heartbeat_at,
  lease_generation, protocol_version
)
SELECT t.id, 'stopped-probe', 'deadbeef',
       clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '2 minutes',
       ('60000000-0000-0000-0000-' || lpad(row_number() OVER (ORDER BY t.id)::text, 12, '0'))::uuid,
       2
  FROM public.tournaments t;

/* Stage B removes application-role table DML. The owner can still exercise
   trigger behavior directly, while the SECURITY DEFINER probe models an RPC. */
REVOKE ALL ON public.tournaments, public.tournament_players,
  public.tables, public.table_seats FROM PUBLIC, anon, authenticated, service_role;
