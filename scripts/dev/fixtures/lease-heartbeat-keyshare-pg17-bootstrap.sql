CREATE SCHEMA auth;
CREATE SCHEMA smarter_private;

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

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

/* The executable runner derives the six byte-authenticated #5 preimages from
   their canonical migrations. This bootstrap supplies only their runtime
   relations and inert callees; no simplified authority body may masquerade
   as a production preimage. */
