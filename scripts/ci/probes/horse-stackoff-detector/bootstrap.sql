-- The smallest stand-in for the production relations the detector reads.
-- Column sets are the ones 20260927220637 actually touches; nothing here is a
-- claim about the full production shape.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  is_horse boolean
);
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  tournament_type text
);
CREATE TABLE public.hand_history (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  game_variant text,
  big_blind numeric,
  pot_size numeric,
  players jsonb,
  winners jsonb,
  actions jsonb,
  hole_cards jsonb,
  community_cards text[],
  community_cards2 text[],
  bomb_pot jsonb,
  tournament_id uuid
);
CREATE TABLE public.hand_atomic_commits (
  hand_id uuid NOT NULL,
  table_id uuid NOT NULL,
  post_commit_payload jsonb,
  post_commit_payload_hash text
);
CREATE TABLE public.horse_hand_reviews (
  hand_id uuid NOT NULL,
  horse_user_id uuid NOT NULL,
  leak_tags text[]
);
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
