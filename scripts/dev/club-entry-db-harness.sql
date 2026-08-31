-- Minimal pre-existing production schema needed to compile the four Club Entry migrations.
-- This file is for an ephemeral local PostgreSQL syntax/DDL gate only.

CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

CREATE TABLE public.clubs (
  id uuid PRIMARY KEY,
  club_id integer UNIQUE,
  name text,
  slug text,
  description text,
  color_theme text,
  is_public boolean,
  requires_approval boolean,
  owner_id uuid,
  level integer,
  logo_url text,
  avatar_url text,
  member_count integer
);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  username text,
  display_name text,
  arena_avatar_url text,
  avatar_url text,
  player_number text,
  is_horse boolean
);
CREATE TABLE public.club_members (
  club_id uuid,
  user_id uuid,
  role text,
  status text,
  chip_balance numeric,
  PRIMARY KEY (club_id, user_id)
);
CREATE TABLE public.audit_trail (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  club_id uuid,
  actor_id uuid NOT NULL,
  actor_role text NOT NULL,
  action text,
  target_type text,
  target_id uuid,
  after_state jsonb
);
CREATE TABLE public.friendships (user_id uuid, friend_id uuid);
CREATE TABLE public.unions (id uuid PRIMARY KEY, owner_id uuid);
CREATE TABLE public.union_admins (union_id uuid, user_id uuid);
CREATE TABLE public.union_clubs (union_id uuid, club_id uuid);
CREATE TABLE public.user_presence (user_id uuid, status text, current_table_id uuid);
CREATE TABLE public.rate_limits (
  user_id uuid,
  action text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.club_join_requests (
  club_id uuid,
  user_id uuid,
  status text,
  created_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  UNIQUE (club_id, user_id)
);
CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  name text,
  game_variant text,
  small_blind numeric,
  big_blind numeric,
  club_id uuid,
  status text
);
CREATE TABLE public.table_seats (table_id uuid, user_id uuid, left_at timestamptz);
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  name text,
  buy_in_amount numeric,
  club_id uuid,
  status text
);
CREATE TABLE public.tournament_players (tournament_id uuid, user_id uuid, status text);

CREATE FUNCTION public.fn_join_club(uuid) RETURNS jsonb LANGUAGE sql AS
$$ SELECT '{"status":"active"}'::jsonb $$;
CREATE FUNCTION public.fn_redeem_club_invite_code(uuid, uuid, text) RETURNS jsonb LANGUAGE sql AS
$$ SELECT '{"success":true}'::jsonb $$;
