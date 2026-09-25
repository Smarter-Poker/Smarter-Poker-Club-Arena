-- The minimum schema public.cleanup_old_hole_cards() touches, with
-- production's column types, defaults, constraints, RLS shape and GRANTs.
-- The privilege shape is part of the test, not decoration: on production
-- smarter_private.f06_hand_permits is readable by postgres ONLY
-- (relacl {postgres=arwdDxtm/postgres}) while the cleanup itself is
-- SECURITY INVOKER and executable by service_role. A retention predicate
-- that reads the permit table directly from that invoker body therefore
-- behaves differently for the two callers, which is why this fixture
-- reproduces the grants exactly. Nothing here is a copy of production data.
\set ON_ERROR_STOP on

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

-- Supabase's auth.uid(), which one of the live hole-card policies calls.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE public.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid
);

CREATE TABLE public.table_hole_cards (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  user_id uuid NOT NULL,
  seat_number integer NOT NULL,
  cards jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT table_hole_cards_pkey PRIMARY KEY (id),
  CONSTRAINT table_hole_cards_table_hand_user_unique UNIQUE (table_id, hand_number, user_id)
);
ALTER TABLE public.table_hole_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own hole cards" ON public.table_hole_cards
  FOR SELECT USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Service role can insert hole cards" ON public.table_hole_cards
  FOR INSERT WITH CHECK (true);
CREATE POLICY block_hole_cards_update ON public.table_hole_cards FOR UPDATE USING (false);
CREATE POLICY block_hole_cards_delete ON public.table_hole_cards FOR DELETE USING (false);
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.table_hole_cards TO anon, authenticated;
REVOKE TRUNCATE ON public.table_hole_cards FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.table_hole_cards TO service_role;

CREATE SCHEMA smarter_private;
GRANT USAGE ON SCHEMA smarter_private TO anon, authenticated, service_role;

-- The production permit table: state CHECK carries the whole enum, and
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
