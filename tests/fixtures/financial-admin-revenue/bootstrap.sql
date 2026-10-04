CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL
);

CREATE TABLE public.clubs (
  id uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.club_members (
  club_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  status text NOT NULL
);

CREATE OR REPLACE FUNCTION public.fn_is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid() AND p.role IN ('admin', 'superadmin', 'god')
  )
$$;

CREATE OR REPLACE FUNCTION public.ca_can_view_club_finances(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT public.fn_is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.club_members m
     WHERE m.club_id = p_club_id
       AND m.user_id = auth.uid()
       AND m.status = 'active'
       AND m.role IN ('owner', 'admin', 'super_agent')
  )
$$;

CREATE TABLE public.rake_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  club_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  rake_amount numeric NOT NULL,
  is_tournament boolean NOT NULL DEFAULT false,
  tournament_id uuid
);

CREATE TABLE public.ca_club_rake_daily (
  club_id uuid NOT NULL,
  stat_date date NOT NULL,
  hands bigint NOT NULL DEFAULT 0,
  rake numeric NOT NULL DEFAULT 0,
  bbj numeric NOT NULL DEFAULT 0,
  pot numeric NOT NULL DEFAULT 0,
  source_rows bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, stat_date)
);

CREATE TABLE public.ca_club_tournament_daily (
  club_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  stat_date date NOT NULL,
  fee numeric NOT NULL DEFAULT 0,
  winnings numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, tournament_id, stat_date)
);

INSERT INTO public.profiles (id, role) VALUES
  ('20000000-0000-4000-8000-000000000001', 'owner'),
  ('20000000-0000-4000-8000-000000000002', 'admin'),
  ('20000000-0000-4000-8000-000000000003', 'member');

INSERT INTO public.clubs (id, name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Alpha Club'),
  ('10000000-0000-4000-8000-000000000002', 'Bravo Club');

INSERT INTO public.club_members (club_id, user_id, role, status) VALUES
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'owner', 'active'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003', 'member', 'active');

-- More than the retired 5,000-row browser ceiling, all on the most recent
-- complete UTC ledger day. The live UTC day is deliberately absent.
INSERT INTO public.rake_records (club_id, created_at, rake_amount)
SELECT '10000000-0000-4000-8000-000000000001', now() - interval '1 day', 0.01
  FROM generate_series(1, 6001);

INSERT INTO public.rake_records (club_id, created_at, rake_amount)
SELECT '10000000-0000-4000-8000-000000000002', now() - interval '1 day', 0.02
  FROM generate_series(1, 100);

INSERT INTO public.rake_records (club_id, created_at, rake_amount) VALUES
  ('10000000-0000-4000-8000-000000000001', now() - interval '6 days', 4.00),
  ('10000000-0000-4000-8000-000000000002', now() - interval '3 days', 3.00),
  ('10000000-0000-4000-8000-000000000001', now() - interval '4 days', 0.0049),
  ('10000000-0000-4000-8000-000000000001', now() - interval '5 days', 0.0049),
  ('10000000-0000-4000-8000-000000000001', now() - interval '7 days', 0.0049),
  ('10000000-0000-4000-8000-000000000001', now() - interval '20 days', 999.00);

INSERT INTO public.rake_records
  (club_id, created_at, rake_amount, is_tournament, tournament_id)
VALUES
  ('10000000-0000-4000-8000-000000000001', now() - interval '1 day', 2.50, true,
   '30000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', now() - interval '2 days', 1.25, true,
   '30000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000002', now() - interval '1 day', 4.00, true,
   '30000000-0000-4000-8000-000000000003');

INSERT INTO public.ca_club_rake_daily (club_id, stat_date, hands, rake, source_rows)
SELECT club_id, (created_at AT TIME ZONE 'UTC')::date, count(*), sum(rake_amount), count(*)
  FROM public.rake_records
 WHERE NOT is_tournament
 GROUP BY club_id, (created_at AT TIME ZONE 'UTC')::date;

INSERT INTO public.ca_club_tournament_daily
  (club_id, tournament_id, stat_date, fee)
SELECT club_id, tournament_id, (created_at AT TIME ZONE 'UTC')::date, sum(rake_amount)
  FROM public.rake_records
 WHERE is_tournament
 GROUP BY club_id, tournament_id, (created_at AT TIME ZONE 'UTC')::date;

CREATE TABLE public.fixture_expected_revenue (
  scope text PRIMARY KEY,
  total numeric NOT NULL
);
INSERT INTO public.fixture_expected_revenue (scope, total)
SELECT 'club-alpha', COALESCE(sum(rake_amount), 0)
  FROM public.rake_records
 WHERE club_id = '10000000-0000-4000-8000-000000000001'
   AND (created_at AT TIME ZONE 'UTC')::date BETWEEN
     (now() AT TIME ZONE 'UTC')::date - 7 AND (now() AT TIME ZONE 'UTC')::date - 1
UNION ALL
SELECT 'platform', COALESCE(sum(rake_amount), 0)
  FROM public.rake_records
 WHERE (created_at AT TIME ZONE 'UTC')::date BETWEEN
   (now() AT TIME ZONE 'UTC')::date - 7 AND (now() AT TIME ZONE 'UTC')::date - 1;

GRANT USAGE ON SCHEMA public, auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT SELECT ON public.fixture_expected_revenue TO authenticated;
