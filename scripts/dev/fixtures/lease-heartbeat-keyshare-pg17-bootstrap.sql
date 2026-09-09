CREATE SCHEMA smarter_private;

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT 30;
$function$;

CREATE TABLE public.engine_table_leases (
  table_id uuid PRIMARY KEY,
  instance_id text NOT NULL,
  lease_generation uuid NOT NULL,
  protocol_version integer NOT NULL DEFAULT 2,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY,
  instance_id text NOT NULL,
  lease_generation uuid NOT NULL,
  protocol_version integer NOT NULL DEFAULT 2,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  tournament_id uuid REFERENCES public.tournaments(id)
);

INSERT INTO public.tournaments(id)
VALUES ('22222222-2222-4222-8222-222222222222');

INSERT INTO public.tables(id, tournament_id)
VALUES
  ('11111111-1111-4111-8111-111111111111', NULL),
  ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222');

INSERT INTO public.engine_table_leases(
  table_id,
  instance_id,
  lease_generation
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'probe-owner',
  '33333333-3333-4333-8333-333333333333'
);

INSERT INTO public.engine_tournament_leases(
  tournament_id,
  instance_id,
  lease_generation
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  'probe-owner',
  '44444444-4444-4444-8444-444444444444'
);

/* The bodies below are deliberately small, but their lease reads and exact
   production signatures are byte-for-byte cutover fixtures.  The migration
   must patch all four and must leave the ordinary tournament-parent lock in
   the settlement function unchanged. */
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb,
  p_rake numeric,
  p_bbj numeric,
  p_ref text,
  p_inflow numeric,
  p_hand_row jsonb,
  p_units jsonb,
  p_instance_id text,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
BEGIN
  SELECT t.tournament_id INTO v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;

  IF v_tournament_id IS NULL THEN
    PERFORM 1
      FROM public.engine_table_leases l
     WHERE l.table_id = p_table_id
     FOR SHARE;
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
     FOR SHARE;
    PERFORM 1
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
  END IF;
  RETURN jsonb_build_object('ok', FOUND);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_resolve_unbound_pending_addons(
  p_table_id uuid,
  p_max_buy_in numeric,
  p_instance_id text,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM 1
    FROM public.engine_table_leases l
   WHERE l.table_id = p_table_id
   FOR SHARE;
  RETURN jsonb_build_object('ok', FOUND);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_close_empty_tournament_table(
  p_tournament_id uuid,
  p_table_id uuid,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM 1
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
     AND l.protocol_version = 2
     AND l.lease_generation = p_lease_generation
     AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
   FOR SHARE;
  RETURN jsonb_build_object('ok', FOUND);
END;
$function$;

CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid := '22222222-2222-4222-8222-222222222222';
  v_lease_generation uuid := '44444444-4444-4444-8444-444444444444';
  v_stale_seconds integer := 30;
BEGIN
  PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     FOR SHARE;
END;
$function$;
