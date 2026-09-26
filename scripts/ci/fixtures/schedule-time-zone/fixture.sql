-- Minimal native fixture for scripts/ci/test-schedule-time-zone.py.
--
-- Supplies only what the schedule migrations reference outside themselves:
-- the Supabase roles, auth.uid() (read from a GUC the harness sets per
-- probe), the union/club authorization inputs, and the MTT classifier the
-- current fn_upsert_tournament_schedule body calls. The schedule tables and
-- functions themselves are installed from the repository migrations, never
-- restated here.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.unions (id uuid PRIMARY KEY, owner_id uuid);
CREATE TABLE public.union_admins (union_id uuid, user_id uuid);
CREATE TABLE public.fixture_club_admins (club_id uuid, user_id uuid);
CREATE FUNCTION public.is_club_admin(p_club_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT EXISTS (SELECT 1 FROM public.fixture_club_admins
                      WHERE club_id = p_club_id AND user_id = p_user_id) $$;
CREATE FUNCTION public.fn_ca_is_new_mtt(jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT false $$;

INSERT INTO public.fixture_club_admins VALUES
  ('00000000-0000-4000-8000-00000000c1ab', '00000000-0000-4000-8000-0000000000a1');
