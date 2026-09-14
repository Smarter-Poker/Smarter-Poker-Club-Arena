CREATE SCHEMA auth;
CREATE SCHEMA smarter_private;
CREATE SCHEMA realtime;

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.clubs (id uuid PRIMARY KEY);
CREATE TABLE public.chip_ledger (id bigint PRIMARY KEY);
CREATE TABLE public.tournament_tickets (id uuid PRIMARY KEY);
CREATE TABLE public.engine_leader (heartbeat_at timestamptz);
CREATE TABLE realtime.subscription (id bigint PRIMARY KEY);

CREATE TABLE public.engine_maintenance_break (
  id boolean PRIMARY KEY CHECK (id),
  phase text NOT NULL,
  announced_at timestamptz NOT NULL,
  break_started_at timestamptz,
  enforce_freeze boolean NOT NULL,
  break_ends_at timestamptz,
  reason text NOT NULL,
  declared_by text,
  ownership_token uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION public.fn_active_maintenance_release_boundary()
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $function$
  SELECT NULL::timestamptz;
$function$;

CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                  AND b.announced_at + INTERVAL '2 minutes' <= clock_timestamp()
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$;

CREATE OR REPLACE FUNCTION public.fn_serialize_engine_maintenance_break_write()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* PostgreSQL takes ACCESS EXCLUSIVE before firing a TRUNCATE trigger. Waiting
     for the advisory boundary from there would invert the canonical order
     against an admitted entry that next reads this table. This singleton has
     no legitimate truncate path, so refuse immediately instead of deadlocking. */
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'engine_maintenance_break may not be truncated'
      USING ERRCODE = '0A000';
  END IF;
  /* One exclusive writer boundary. The matching entry paths take this key in
     shared mode, so purchases stay concurrent with each other but can never
     straddle a maintenance-row commit. Transaction scope prevents a pooled
     connection from retaining the lock. */
  PERFORM pg_advisory_xact_lock(530090, 1);
  RETURN NULL;
END;
$function$;

CREATE TRIGGER aa_serialize_maintenance_break_write
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
ON public.engine_maintenance_break
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_serialize_engine_maintenance_break_write();

INSERT INTO public.engine_maintenance_break (
  id,phase,announced_at,break_started_at,enforce_freeze,break_ends_at,
  reason,declared_by,ownership_token
) VALUES (
  true,'counting_down',clock_timestamp(),clock_timestamp(),true,
  clock_timestamp()+interval '10 minutes','Stage-B PG17 Probe',
  'probe','77777777-7777-4777-8777-777777777777'
);

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT 'service_role'::text;
$function$;

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
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_generation uuid NOT NULL,
  protocol_version integer NOT NULL DEFAULT 2,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_generation uuid NOT NULL,
  protocol_version integer NOT NULL DEFAULT 2,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'RUNNING'
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  tournament_id uuid REFERENCES public.tournaments(id),
  status text NOT NULL DEFAULT 'active',
  current_players integer NOT NULL DEFAULT 0,
  is_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id),
  left_at timestamptz
);

CREATE TABLE public.table_pending_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id),
  user_id uuid NOT NULL,
  kind text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL REFERENCES public.tables(id),
  hand_number bigint NOT NULL,
  post_commit_payload jsonb,
  PRIMARY KEY (table_id, hand_number)
);

CREATE TABLE public.tournament_mutator_scheduler_retirement_receipts (
  migration_version text PRIMARY KEY
);

INSERT INTO public.tournament_mutator_scheduler_retirement_receipts(
  migration_version
) VALUES ('20260910042112_stage_b_current_postimage_contraction');

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(
  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb
) RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT jsonb_build_object('success', true);
$function$;

CREATE OR REPLACE FUNCTION public.resolve_pending_addon(uuid,numeric)
RETURNS TABLE(applied numeric,refunded numeric)
LANGUAGE sql
AS $function$
  SELECT 0::numeric,0::numeric;
$function$;

INSERT INTO public.tournaments(id)
VALUES ('22222222-2222-4222-8222-222222222222');

INSERT INTO public.tables(id, tournament_id)
VALUES
  ('11111111-1111-4111-8111-111111111111', NULL),
  ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222');

INSERT INTO public.engine_table_leases(
  table_id,
  instance_id,
  lease_generation,
  heartbeat_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'probe-owner',
  '33333333-3333-4333-8333-333333333333',
  clock_timestamp()-interval '2 minutes'
);

INSERT INTO public.engine_tournament_leases(
  tournament_id,
  instance_id,
  lease_generation,
  heartbeat_at
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  'probe-owner',
  '44444444-4444-4444-8444-444444444444',
  clock_timestamp()-interval '2 minutes'
);

/* The executable runner derives the six byte-authenticated #5 preimages from
   their canonical migrations. This bootstrap supplies only their runtime
   relations and inert callees; no simplified authority body may masquerade
   as a production preimage. */
