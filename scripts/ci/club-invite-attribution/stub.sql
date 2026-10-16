-- Minimal stand-in for the production objects the invite migration touches.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA auth; CREATE SCHEMA extensions;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, username text, alias text, player_number text, phone text,
  phone_verified boolean DEFAULT false, referred_by uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.clubs (
  id uuid PRIMARY KEY, club_id integer, slug text, name text, description text, logo_url text,
  avatar_url text, member_count integer DEFAULT 0, lifecycle_status text DEFAULT 'active',
  asset text DEFAULT 'chips', owner_id uuid);
CREATE TABLE public.club_members (
  club_id uuid, user_id uuid, role text DEFAULT 'player', status text, agent_id uuid,
  invited_by uuid, updated_at timestamptz, PRIMARY KEY (club_id, user_id));
CREATE TABLE public.agents (
  club_id uuid, user_id uuid, status text, total_players int, active_player_count int, updated_at timestamptz);
CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid REFERENCES auth.users(id), referee_id uuid UNIQUE REFERENCES auth.users(id),
  referral_code_used varchar, status varchar CHECK (status IN ('pending','completed')),
  created_at timestamptz DEFAULT now(), completed_at timestamptz);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text, title text, message text,
  data jsonb, action_url text, read boolean, is_read boolean, created_at timestamptz DEFAULT now());
CREATE TABLE public.anti_cheat_exemptions (player_id uuid, flag_type text, reason text);

CREATE FUNCTION public.get_club_players_playing(text) RETURNS integer LANGUAGE sql AS $$ SELECT 7 $$;
CREATE FUNCTION public.fn_club_membership_lock(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.fn_ca_commerce_admit(text, uuid, text, text, uuid) RETURNS jsonb LANGUAGE sql
  AS $$ SELECT '{"allowed":true}'::jsonb $$;
