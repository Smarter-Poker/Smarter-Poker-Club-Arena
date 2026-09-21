-- The minimum schema public.sp_prune_hand_history(integer) touches, with
-- production's column types, keys, RLS shape and GRANTs.
--
-- The privilege shape is part of the test. On production
-- smarter_private.f06_hand_permits is readable by postgres ONLY
-- (relacl {postgres=arwdDxtm/postgres}, RLS enabled, zero policies, FORCE off)
-- while the prune itself is SECURITY INVOKER. Its ACL is postgres-only today,
-- so an inline read would work for the cron caller and silently stop working
-- the day the ACL widens; the definer helper is what makes the predicate
-- independent of who calls. Nothing here is a copy of production data.
\set ON_ERROR_STOP on

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END;
$roles$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'RUNNING',
  tournament_type text,
  variant text
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid REFERENCES public.tournaments(id)
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  is_horse boolean
);

-- Singleton policy row: horse_retention_days drives the prune boundary.
CREATE TABLE public.hand_history_retention_policy (
  id boolean PRIMARY KEY DEFAULT true,
  horse_retention_days integer NOT NULL DEFAULT 8
);
INSERT INTO public.hand_history_retention_policy (id, horse_retention_days) VALUES (true, 8);

CREATE TABLE public.hand_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  table_id uuid,
  tournament_id uuid,
  hand_number integer,
  players jsonb,
  has_human boolean,
  reported boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT hand_history_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_hand_history_global_hand_number
  ON public.hand_history USING btree (hand_number) WHERE (hand_number >= 1000000);
CREATE INDEX idx_hand_history_table_handnum
  ON public.hand_history USING btree (table_id, hand_number DESC);

-- hand_atomic_commits carries its OWN table_id/hand_number as its primary key,
-- and a uuid hand_id unique-keyed to the history row. The prune deletes it by
-- hand_id, never by (table_id, hand_number).
CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  post_commit_payload jsonb,
  post_commit_completed_at timestamp with time zone,
  CONSTRAINT hand_atomic_commits_pkey PRIMARY KEY (table_id, hand_number),
  CONSTRAINT hand_atomic_commits_hand_id_key UNIQUE (hand_id),
  CONSTRAINT hand_atomic_commits_hand_number_key UNIQUE (hand_number)
);

CREATE TABLE public.rake_attributions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  hand_id uuid NOT NULL,
  table_id uuid,
  player_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT rake_attributions_pkey PRIMARY KEY (id),
  CONSTRAINT uq_rake_attributions_hand_player UNIQUE (hand_id, player_id)
);

CREATE TABLE public.ca_hand_player_idx (
  user_id uuid NOT NULL,
  hand_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ca_hand_player_idx_pkey PRIMARY KEY (user_id, hand_id)
);

CREATE TABLE public.bbj_payouts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  table_id uuid NOT NULL,
  hand_number bigint
);

CREATE TABLE public.hand_projection_outbox (
  hand_id uuid NOT NULL
);

CREATE TABLE public.tournament_knockout_candidates (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  hand_id uuid NOT NULL,
  state text NOT NULL
);

CREATE TABLE public.tournament_terminal_settlements (
  tournament_id uuid NOT NULL
);

CREATE TABLE public.tournament_cancellation_receipts (
  tournament_id uuid NOT NULL
);

CREATE SCHEMA smarter_private;
GRANT USAGE ON SCHEMA smarter_private TO anon, authenticated, service_role;

-- The production permit table: the state CHECK carries the whole enum, and
-- (table_id, hand_number) is UNIQUE, so one hand has at most one permit.
CREATE TABLE smarter_private.f06_hand_permits (
  permit_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  table_id uuid NOT NULL,
  lifecycle bigint NOT NULL,
  hand_number bigint NOT NULL,
  custody_id uuid NOT NULL,
  generation uuid NOT NULL,
  state text NOT NULL DEFAULT 'reserved'::text,
  evidence_id uuid,
  CONSTRAINT f06_hand_permits_pkey PRIMARY KEY (permit_id),
  CONSTRAINT f06_hand_permits_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'accepted'::text, 'never_started'::text, 'aborted_unsettled'::text]))),
  CONSTRAINT f06_hand_permits_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.tables(id),
  CONSTRAINT f06_hand_permits_table_id_hand_number_key UNIQUE (table_id, hand_number)
);
-- RLS on, zero policies, FORCE off: the owner reads it, nobody else does.
ALTER TABLE smarter_private.f06_hand_permits ENABLE ROW LEVEL SECURITY;
