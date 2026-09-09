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
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$function$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  starting_chips bigint,
  early_bird_chips bigint NOT NULL DEFAULT 0,
  variant text,
  tournament_type text,
  max_players integer NOT NULL DEFAULT 9,
  current_players integer NOT NULL DEFAULT 0,
  start_time timestamptz,
  started_at timestamptz,
  spin_multiplier numeric,
  spin_reveal_at timestamptz
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'waiting',
  max_players integer NOT NULL DEFAULT 9,
  current_players integer NOT NULL DEFAULT 0
);

CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  chips bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'registered',
  rebuys integer NOT NULL DEFAULT 0,
  add_on boolean NOT NULL DEFAULT false,
  table_id uuid REFERENCES public.tables(id) ON DELETE SET NULL,
  seat_number integer,
  UNIQUE (tournament_id, user_id)
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  user_id uuid,
  seat_number integer NOT NULL,
  stack numeric NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at timestamptz,
  UNIQUE (table_id, seat_number)
);

CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 2
);

CREATE TABLE public.tournament_launch_receipts (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  launch_id uuid NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid()
);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (table_id, hand_number)
);

CREATE TABLE public.tournament_knockout_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  eliminated_user_id uuid NOT NULL,
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL,
  seat_joined_at timestamptz NOT NULL,
  hand_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  stack_before bigint NOT NULL,
  stack_after bigint NOT NULL,
  state text NOT NULL DEFAULT 'pending'
);

CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen()
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$ SELECT false $function$;

/* Minimal exact manager-scope law used by the real RPCs under test. */
CREATE OR REPLACE FUNCTION public.fn_assert_tournament_manager_write_scope(
  p_tournament_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
  v_generation uuid;
BEGIN
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager'
     OR current_setting('app.smarter_manager_request_fenced', true)
       IS DISTINCT FROM 'protocol-2' THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_tournament_id := NULLIF(
      current_setting('app.smarter_tournament_id', true), ''
    )::uuid;
    v_generation := NULLIF(
      current_setting('app.smarter_tournament_lease_generation', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID'
      USING ERRCODE = '22023';
  END;
  IF v_tournament_id IS DISTINCT FROM p_tournament_id OR v_generation IS NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE SCHEMA smarter_private;
REVOKE ALL ON SCHEMA smarter_private FROM PUBLIC;
GRANT USAGE ON SCHEMA smarter_private TO anon, authenticated, service_role;

/* Focused preimage of the strict shared-estate hook. The route array and
   authority behavior are real; unrelated estate paths are intentionally
   omitted from this narrow PG17 catalog. */
CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_headers jsonb;
  v_claims jsonb;
  v_actor text;
  v_protocol text;
  v_request_role text;
  v_path text;
  v_tournament_id uuid;
  v_lease_generation uuid;
  v_manager_exclusive_paths constant text[] := ARRAY[
    'rpc/fn_begin_tournament_launch_atomic',
    'rpc/fn_complete_tournament_launch_atomic',
    'rpc/fn_decline_tournament_rebuy',
    'rpc/process_tournament_rebuy'
  ]::text[];
  v_engine_service_paths constant text[] := ARRAY[
    'rpc/claim_tournament_lease_v2',
    'rpc/heartbeat_tournament_leases_v3'
  ]::text[];
BEGIN
  v_headers := COALESCE(
    NULLIF(current_setting('request.headers', true), '')::jsonb,
    '{}'::jsonb
  );
  v_claims := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
  v_actor := lower(btrim(COALESCE(v_headers ->> 'x-smarter-data-actor', '')));
  v_protocol := btrim(COALESCE(v_headers ->> 'x-smarter-data-protocol', ''));
  v_request_role := btrim(COALESCE(auth.role(), ''));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));
  IF left(v_path, 8) = 'rest/v1/' THEN v_path := substr(v_path, 9); END IF;

  PERFORM set_config('app.smarter_data_actor', '', true);
  PERFORM set_config('app.smarter_tournament_id', '', true);
  PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
  PERFORM set_config('app.smarter_manager_request_fenced', '', true);

  IF v_path = ANY(v_manager_exclusive_paths)
     AND v_actor IS DISTINCT FROM 'tournament-manager' THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_AUTHORITY_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  IF v_path = ANY(v_engine_service_paths)
     AND v_actor NOT IN ('service', 'tournament-manager') THEN
    RAISE EXCEPTION 'ENGINE_DATA_AUTHORITY_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  IF v_actor = '' THEN RETURN; END IF;
  IF v_request_role <> 'service_role' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN'
      USING ERRCODE = '42501';
  END IF;
  IF v_actor <> 'tournament-manager' OR v_protocol <> '2' THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_tournament_id := (v_headers ->> 'x-smarter-tournament-id')::uuid;
    v_lease_generation :=
      (v_headers ->> 'x-smarter-tournament-lease-generation')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID'
      USING ERRCODE = '22023';
  END;
  PERFORM 1
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = v_tournament_id
     AND l.protocol_version = 2
     AND l.lease_generation = v_lease_generation
     AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_FENCED'
      USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.smarter_data_actor', 'tournament-manager', true);
  PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
  PERFORM set_config(
    'app.smarter_tournament_lease_generation', v_lease_generation::text, true
  );
  PERFORM set_config('app.smarter_manager_request_fenced', 'protocol-2', true);
END;
$function$;
REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
  TO anon, authenticated, service_role;

/* Generation-fenced launch begin, with the exact once-only return anchor the
   migration is allowed to extend. */
CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(
  p_tournament_id uuid,
  p_launch_id uuid,
  p_started_at timestamptz,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_result jsonb;
  v_receipt public.tournament_launch_receipts%ROWTYPE;
BEGIN
  SELECT * INTO v_receipt
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    v_result := jsonb_build_object(
      'ok', true, 'claimed', true, 'launch_id', v_receipt.launch_id,
      'replay', true, 'started_at', v_receipt.started_at,
      'completed', v_receipt.completed_at IS NOT NULL,
      'status', (SELECT t.status FROM public.tournaments t WHERE t.id=p_tournament_id)
    );
  ELSE
    INSERT INTO public.tournament_launch_receipts(
      tournament_id, launch_id, started_at, lease_generation
    ) VALUES (
      p_tournament_id, p_launch_id, COALESCE(p_started_at, transaction_timestamp()),
      p_lease_generation
    );
    v_result := jsonb_build_object(
      'ok', true, 'claimed', true, 'launch_id', p_launch_id,
      'replay', false, 'started_at', COALESCE(p_started_at, transaction_timestamp()),
      'completed', false
    );
  END IF;
  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid,uuid,timestamptz,uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid,uuid,timestamptz,uuid
) TO service_role;

/* Exact launch-completion predecessor markers plus a functional focused core. */
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_before_lease_generation(
  p_tournament_id uuid,
  p_launch_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_started_at timestamptz;
BEGIN
  /* launch_stacks_uncredited; s.stack = p.chips;
     public.tournament_knockout_candidates */
  SELECT r.started_at INTO STRICT v_started_at
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id=p_tournament_id AND r.launch_id=p_launch_id
   FOR UPDATE;
  UPDATE public.tournament_launch_receipts
     SET completed_at=transaction_timestamp()
   WHERE tournament_id=p_tournament_id AND launch_id=p_launch_id;
  UPDATE public.tournaments
     SET status='RUNNING', started_at=v_started_at
   WHERE id=p_tournament_id;
  RETURN jsonb_build_object(
    'ok', true, 'completed', true, 'status', 'RUNNING',
    'started_at', v_started_at, 'completed_at', transaction_timestamp()
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(
  p_tournament_id uuid,
  p_launch_id uuid,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.fn_assert_tournament_manager_write_scope(p_tournament_id);
  IF NULLIF(
       current_setting('app.smarter_tournament_lease_generation', true), ''
     )::uuid IS DISTINCT FROM p_lease_generation THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.fn_complete_tournament_launch_before_lease_generation(
    p_tournament_id, p_launch_id
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(
  p_tournament_id uuid,
  p_user_id uuid,
  p_rebuy_type text,
  p_cost numeric,
  p_chips numeric,
  p_current_level integer DEFAULT NULL,
  p_client_token text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_add bigint := p_chips::bigint;
  v_stack bigint;
BEGIN
  IF p_rebuy_type = 'addon' THEN
    UPDATE public.tournament_players
       SET chips=chips+v_add, add_on=true
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
    RETURNING chips INTO v_stack;
  ELSIF p_rebuy_type = 'reentry' THEN
    UPDATE public.tournament_players
       SET chips=v_add, status='playing', rebuys=rebuys+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
    RETURNING chips INTO v_stack;
  ELSE
    UPDATE public.tournament_players
       SET chips=chips+v_add, status='playing', rebuys=rebuys+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
    RETURNING chips INTO v_stack;
  END IF;
  UPDATE public.table_seats s
     SET stack=v_stack
    FROM public.tables t
   WHERE t.id=s.table_id AND t.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  RETURN jsonb_build_object('success', true, 'new_stack', v_stack);
END;
$function$;
REVOKE ALL ON FUNCTION public.process_tournament_rebuy(
  uuid,uuid,text,numeric,numeric,integer,text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_tournament_rebuy(
  uuid,uuid,text,numeric,numeric,integer,text
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(uuid,uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('ok', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(
  p_table_id uuid,
  p_seat_number integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_t record;
  v_uid uuid := auth.uid();
  v_stack bigint;
BEGIN
  SELECT t.id, t.starting_chips INTO STRICT v_t
    FROM public.tournaments t
    JOIN public.tables b ON b.tournament_id=t.id
   WHERE b.id=p_table_id;
  v_stack := v_t.starting_chips;
  UPDATE public.tournament_players
     SET status = 'playing', chips = v_stack, table_id = p_table_id, seat_number = p_seat_number
   WHERE tournament_id = v_t.id AND user_id = v_uid;
  RETURN jsonb_build_object('ok', true, 'stack', v_stack);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(
  p_tournament_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_already boolean := false;
  v_reg jsonb;
  v_stack bigint;
BEGIN
  SELECT t.starting_chips INTO STRICT v_stack
    FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF NOT v_already THEN
    v_reg := public.fn_register_horse_for_tournament(p_tournament_id, p_user_id);
    IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
       AND COALESCE(v_reg->>'reason','') <> 'already_registered' THEN
      RETURN jsonb_build_object('ok', false, 'reason', COALESCE(v_reg->>'reason','register_failed'));
    END IF;
  END IF;

  UPDATE public.table_seats
     SET stack=stack
   WHERE false;
  UPDATE public.tournament_players
     SET status='playing', chips=v_stack
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id;
  RETURN jsonb_build_object('ok', true, 'stack', v_stack);
END;
$function$;

/* The migration must remove both objects, not merely stop calling them. */
CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobname text NOT NULL
);
CREATE FUNCTION cron.unschedule(p_job_id bigint)
RETURNS boolean
LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM cron.job WHERE jobid=p_job_id;
  RETURN FOUND;
END;
$function$;
INSERT INTO cron.job(jobname) VALUES ('credit-stalled-seat-first-stacks');

CREATE OR REPLACE FUNCTION public.fn_credit_stalled_seat_first_stacks()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
AS $function$ SELECT 0 $function$;

/* One row which predates the ledger proves the migration never invents a
   receipt from a mutable balance. */
INSERT INTO public.tournaments(
  id,name,status,starting_chips,variant,tournament_type,max_players
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  'Legacy Supply', 'REGISTERING', 1000, 'mtt', 'MTT', 9
);
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,chips,status
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  0,'registered'
);
INSERT INTO public.engine_tournament_leases(
  tournament_id,instance_id,lease_generation,protocol_version
) VALUES (
  '10000000-0000-4000-8000-000000000001','fixture',
  '40000000-0000-4000-8000-000000000001',2
);
