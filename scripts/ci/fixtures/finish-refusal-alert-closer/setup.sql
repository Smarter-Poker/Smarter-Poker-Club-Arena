-- Minimal shapes of every relation fn_resolve_settled_financial_alerts reads.
-- Column names and types follow production (read 2026-09-27); nothing here is
-- a live row. The preimage resolver is installed by the driver from the
-- migration's own embedded $pre$ text, so the test runs the exact production
-- body before the migration replaces it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.financial_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text NOT NULL,
  source text NOT NULL,
  message text NOT NULL,
  context jsonb DEFAULT '{}'::jsonb,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid,
  resolution text
);
CREATE INDEX financial_alerts_unresolved_source_idx
  ON public.financial_alerts USING btree (source) WHERE (NOT resolved);

CREATE TABLE public.wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  related_entity_id uuid, user_id uuid, type text, category text, amount numeric
);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL, hand_number bigint NOT NULL, hand_id uuid NOT NULL UNIQUE,
  payload_hash text NOT NULL, stack_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  post_commit_payload jsonb, post_commit_request_hash text,
  post_commit_payload_hash text, post_commit_completed_at timestamptz,
  post_commit_result jsonb,
  PRIMARY KEY (table_id, hand_number)
);

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY, name text, status text, ended_at timestamptz
);

CREATE TABLE public.tournament_terminal_settlements (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  winner_id uuid NOT NULL, settlement_mode text NOT NULL,
  cash_payout_count integer, cash_payout_total numeric, completed_at timestamptz
);

CREATE TABLE public.tournament_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid, user_id uuid, position integer, amount numeric,
  paid_at timestamptz
);
