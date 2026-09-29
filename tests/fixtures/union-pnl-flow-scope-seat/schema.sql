-- Native qualification schema additions (production column lists,
-- information_schema 2026-09-28) for the flow, link and satellite proofs.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;
CREATE TABLE public.cash_hand_participant_manifests(id uuid PRIMARY KEY, table_id uuid, hand_number bigint, captured_at timestamptz,
 lease_instance_id text, lease_generation uuid, request jsonb, game_scope jsonb, participants jsonb, issues jsonb, funding_provenance_complete boolean,
 UNIQUE(table_id,hand_number));
CREATE TABLE public.hand_atomic_commits(table_id uuid, hand_number bigint, hand_id uuid, payload_hash text, stack_result jsonb, committed_at timestamptz,
 post_commit_payload jsonb, post_commit_request_hash text, post_commit_payload_hash text, post_commit_completed_at timestamptz, post_commit_result jsonb,
 PRIMARY KEY(table_id,hand_number));
CREATE TABLE public.cash_seat_move_receipts(move_id uuid PRIMARY KEY, player_id uuid, game_id uuid, club_id uuid, from_table_id uuid, from_seat_number integer,
 source_occupancy_id uuid, to_table_id uuid, to_seat_number integer, destination_occupancy_id uuid, amount numeric, receipt jsonb, created_at timestamptz,
 transaction_id xid8);
CREATE TABLE public.clubs(id uuid PRIMARY KEY, asset text);
CREATE TABLE public.profiles(id uuid PRIMARY KEY, is_horse boolean);
CREATE TABLE public.tournament_satellite_awards(tournament_id uuid, place integer, user_id uuid, delivery_kind text, amount numeric, payout_id uuid,
 payout_source text, idempotency_key text, registration_id uuid, ticket_id uuid, obligation_id uuid, obligation_kind text, created_at timestamptz);
CREATE TABLE public.tournament_satellite_settlements(tournament_id uuid PRIMARY KEY, target_id uuid, winner_id uuid, seat_count integer,
 qualifier_ids uuid[], settled_at timestamptz, receipt_version integer);
CREATE TABLE public.tournament_tickets(id uuid PRIMARY KEY, club_id uuid, holder_id uuid, value numeric, status text, redeemed_at timestamptz,
 redemption_mode text, source_tournament_id uuid, source_satellite_id uuid, created_at timestamptz);
-- Read by the link proof for a hand whose live atomic row still exists; the
-- production comparator is not under test here (no live row is seeded).
CREATE FUNCTION public.fn_cash_atomic_original_matches(p_original jsonb, p_live jsonb, p_request jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE AS $$ SELECT p_original=p_live $$;
