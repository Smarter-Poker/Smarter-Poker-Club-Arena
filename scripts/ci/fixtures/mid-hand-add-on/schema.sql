-- Minimal native schema for smarter_private.f06_movement_prior: every relation
-- and column the function reads, with production's names and types. No data.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS extensions;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='extensions' AND p.proname='digest') THEN
    EXECUTE 'CREATE FUNCTION extensions.digest(bytea,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $f$ SELECT public.digest($1,$2) $f$';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS smarter_private;

CREATE TABLE public.tournaments(id uuid PRIMARY KEY, status text, addon_chips numeric, starting_chips numeric, rebuy_chips numeric);
CREATE TABLE public.tables(id uuid PRIMARY KEY, tournament_id uuid, f06_lifecycle bigint, status text, is_deleted boolean);
CREATE TABLE public.hand_atomic_commits(hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint, committed_at timestamptz,
  payload_hash text, stack_result jsonb, post_commit_payload jsonb, post_commit_payload_hash text, post_commit_request_hash text,
  post_commit_completed_at timestamptz, post_commit_result jsonb);
CREATE TABLE public.hand_history(id uuid PRIMARY KEY, table_id uuid, hand_number bigint, created_at timestamptz);
CREATE TABLE public.hand_private_state(table_id uuid, hand_number bigint);
CREATE TABLE public.hand_state_snapshots(id bigserial PRIMARY KEY, table_id uuid, hand_number bigint, is_complete boolean);
CREATE TABLE public.table_seats(id uuid PRIMARY KEY, table_id uuid, user_id uuid, seat_number integer, stack numeric,
  joined_at timestamptz, left_at timestamptz, occupancy_id uuid);
CREATE TABLE public.tournament_players(id uuid PRIMARY KEY, tournament_id uuid, user_id uuid, chips numeric, status text,
  eliminated_at timestamptz, table_id uuid, seat_number integer, add_on boolean, rebuys integer);
CREATE TABLE public.tournament_seat_move_receipts(request_id uuid PRIMARY KEY, tournament_id uuid, user_id uuid,
  source_table_id uuid, source_seat_id uuid, source_seat_number integer, destination_table_id uuid, destination_seat_id uuid,
  destination_seat_number integer, stack numeric, moved_at timestamptz, source_mode text);
CREATE TABLE public.tournament_participant_funding_receipts(id uuid PRIMARY KEY, tournament_id uuid, user_id uuid,
  registration_id uuid, operation text, observed_at timestamptz, purchase_key text, ledger_id uuid,
  tournament_snapshot jsonb, registration_snapshot jsonb);
CREATE TABLE public.chip_ledger(id uuid PRIMARY KEY, from_entity_id uuid, tournament_id uuid, category text, from_type text,
  to_type text, status text, created_at timestamptz, amount numeric);
CREATE TABLE public.wallet_credit_idempotency(key text PRIMARY KEY, created_at timestamptz, user_id uuid, amount numeric);
CREATE TABLE public.ca_seat_stack_rebases(id bigint PRIMARY KEY, settlement_id uuid, table_id uuid NOT NULL, hand_id uuid NOT NULL,
  hand_number bigint, user_id uuid NOT NULL, engine_before numeric NOT NULL, db_before numeric NOT NULL, engine_after numeric NOT NULL,
  written numeric NOT NULL, amount numeric, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE smarter_private.f06_operations(break_id uuid PRIMARY KEY, tournament_id uuid, source_table_id uuid, lifecycle bigint,
  state text, manifest jsonb);
CREATE TABLE smarter_private.f06_members(break_id uuid, user_id uuid, source_seat_id uuid, source_seat_number integer, occupancy_id uuid);
CREATE TABLE smarter_private.f06_attempts(break_id uuid, user_id uuid, state text, receipt jsonb, request_id uuid);
CREATE FUNCTION smarter_private.f06_movement_permits(uuid,uuid,bigint) RETURNS jsonb LANGUAGE sql AS $$ SELECT '[]'::jsonb $$;
CREATE FUNCTION smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"never_dealt":true}'::jsonb $$;
