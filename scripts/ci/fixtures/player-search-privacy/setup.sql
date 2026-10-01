CREATE SCHEMA auth AUTHORIZATION postgres;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '')
$$;

CREATE TABLE public.club_entry_feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL,
  rollout_percent integer NOT NULL
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  username text,
  display_name text,
  alias text,
  player_number text,
  arena_avatar_url text,
  avatar_url text,
  first_name text,
  last_name text,
  full_name text,
  is_online boolean,
  last_seen timestamptz
);

CREATE TABLE public.player_search_preferences (
  user_id uuid PRIMARY KEY,
  discoverable boolean NOT NULL DEFAULT true,
  show_display_name boolean NOT NULL DEFAULT true,
  show_presence boolean NOT NULL DEFAULT true,
  show_current_table boolean NOT NULL DEFAULT true
);

CREATE TABLE public.clubs (
  id uuid PRIMARY KEY,
  club_id integer,
  slug text,
  name text,
  requires_approval boolean,
  is_public boolean,
  status text
);

CREATE TABLE public.club_members (
  club_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text,
  role text,
  PRIMARY KEY (club_id, user_id)
);

CREATE TABLE public.unions (
  id uuid PRIMARY KEY,
  owner_id uuid,
  name text,
  union_code integer,
  code text,
  is_public boolean
);

CREATE TABLE public.union_clubs (
  union_id uuid NOT NULL,
  club_id uuid NOT NULL
);

CREATE TABLE public.union_admins (
  union_id uuid NOT NULL,
  user_id uuid NOT NULL
);

CREATE TABLE public.friendships (
  user_id uuid NOT NULL,
  friend_id uuid NOT NULL
);

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  club_id uuid NOT NULL,
  name text,
  variant text,
  game_type text,
  buy_in_amount numeric,
  status text
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  club_id uuid NOT NULL,
  tournament_id uuid,
  name text,
  game_variant text,
  game_type text,
  small_blind numeric,
  big_blind numeric,
  status text,
  is_deleted boolean,
  is_anonymous boolean,
  restrict_observers boolean
);

CREATE TABLE public.table_seats (
  table_id uuid NOT NULL,
  user_id uuid NOT NULL,
  club_id uuid,
  left_at timestamptz
);

CREATE TABLE public.tournament_players (
  user_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  table_id uuid,
  status text
);

CREATE TABLE public.fixture_roster_access (
  actor_id uuid NOT NULL,
  target_id uuid NOT NULL,
  club_id uuid NOT NULL,
  access text NOT NULL,
  PRIMARY KEY (actor_id, target_id, club_id)
);

CREATE OR REPLACE FUNCTION public.fn_arena_name(
  p_alias text,
  p_username text,
  p_display_name text,
  p_first_name text,
  p_last_name text,
  p_full_name text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(nullif(btrim(p_alias), ''), nullif(btrim(p_username), ''), 'Player')
$$;

CREATE OR REPLACE FUNCTION public.fn_club_role_rank(p_role text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_role
    WHEN 'owner' THEN 60
    WHEN 'co_owner' THEN 50
    WHEN 'admin' THEN 40
    WHEN 'super_agent' THEN 30
    WHEN 'agent' THEN 20
    WHEN 'sub_agent' THEN 10
    ELSE 0
  END
$$;

CREATE OR REPLACE FUNCTION public.ca_club_roster_access(
  p_club_id uuid,
  p_target_user_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT access
       FROM public.fixture_roster_access
      WHERE actor_id = auth.uid()
        AND target_id = p_target_user_id
        AND club_id = p_club_id),
    'identity'
  )
$$;

CREATE OR REPLACE FUNCTION public.ca_club_member_detail(
  p_club_id uuid,
  p_user_id uuid,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
BEGIN
  RETURN jsonb_build_object(
    'capabilities', jsonb_build_object('access', v_access),
    'wallets', CASE WHEN v_access IN ('staff', 'downline', 'service')
                    THEN jsonb_build_object('chip_balance', 777) END,
    'downline', CASE WHEN v_access IN ('staff', 'downline', 'service')
                     THEN jsonb_build_object('downline_direct', 1, 'downline_total', 1) END,
    'stats', CASE WHEN v_access IN ('staff', 'downline', 'service')
                  THEN jsonb_build_object('total_fee', 12.34) END
  );
END
$$;

REVOKE ALL ON FUNCTION public.ca_club_roster_access(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_club_member_detail(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_roster_access(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_member_detail(uuid, uuid, date, date)
  TO authenticated, service_role;

CREATE INDEX idx_profiles_username_trgm
  ON public.profiles USING gin (lower(username) gin_trgm_ops);
CREATE INDEX idx_profiles_display_name_trgm
  ON public.profiles USING gin (lower(display_name) gin_trgm_ops);
CREATE INDEX idx_profiles_alias_trgm
  ON public.profiles USING gin (lower(alias) gin_trgm_ops);
