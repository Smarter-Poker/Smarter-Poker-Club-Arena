-- The tables and columns the hourly sweep's changed checks read, as they are
-- on production (types captured 2026-10-22), and nothing else. A throwaway
-- cluster only; no production connection.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE supabase_admin NOLOGIN;

CREATE TABLE public.chip_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_type text, from_entity_id uuid, to_type text, to_entity_id uuid,
  amount numeric(15,2) NOT NULL, category text, club_id uuid, tournament_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), idempotency_key text, status text DEFAULT 'posted', metadata jsonb);
CREATE INDEX ON public.chip_ledger (created_at);
CREATE INDEX ON public.chip_ledger (to_entity_id, created_at DESC);
CREATE INDEX ON public.chip_ledger (from_entity_id, created_at DESC);
CREATE TABLE public.ca_chip_baseline (club_id uuid, user_id uuid, opening_balance numeric, ledger_at_baseline numeric,
  unledgered_gap numeric, taken_at timestamptz, PRIMARY KEY (club_id, user_id));
CREATE TABLE public.club_members (club_id uuid, user_id uuid, chip_balance numeric, updated_at timestamptz DEFAULT now(),
  role text, PRIMARY KEY (club_id, user_id));
CREATE TABLE public.bbj_pools (id uuid PRIMARY KEY, club_id uuid, pool_amount numeric(14,2) DEFAULT 0, created_at timestamptz,
  main_balance numeric(14,2) DEFAULT 0, backup_balance numeric(14,2) DEFAULT 0, promo_balance numeric(14,2) DEFAULT 0,
  status text, total_paid_out numeric(15,2) DEFAULT 0, merged_into_pool_id uuid);
CREATE TABLE public.ca_bbj_pool_snapshots (id bigserial PRIMARY KEY, pool_id uuid, taken_at timestamptz, is_baseline boolean,
  main numeric DEFAULT 0, backup numeric DEFAULT 0, promo numeric DEFAULT 0);
CREATE TABLE public.bbj_conservation_baseline (id integer PRIMARY KEY, baseline_gap numeric, tolerance numeric,
  measured_at timestamptz, note text, lifetime_residue numeric, pre_ledger_payouts numeric, opening_seeds numeric, epoch_residue numeric);
CREATE TABLE public.bbj_payouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), total_amount numeric(20,2), created_at timestamptz DEFAULT now());
CREATE TABLE public.union_wallet_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount numeric(20,4), tx_type text, created_at timestamptz DEFAULT now());
CREATE TABLE public.chip_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount numeric(14,2), transaction_type text, created_at timestamptz DEFAULT now());
CREATE TABLE public.wallet_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text, category text,
  description text, amount numeric, created_at timestamptz DEFAULT now(), related_entity_id uuid);
CREATE TABLE public.money_flow_checkpoint (metric_key text PRIMARY KEY, as_of timestamptz, total numeric, rows_seen bigint,
  last_verified_at timestamptz, updated_at timestamptz);
CREATE TABLE public.bbj_contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount numeric(14,2), created_at timestamptz DEFAULT now());
CREATE TABLE public.hand_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now());
CREATE TABLE public.ca_ledger_write_failures (id bigserial PRIMARY KEY, occurred_at timestamptz, club_id uuid, user_id uuid,
  delta numeric, sqlstate text, message text);
CREATE TABLE public.ca_seat_stack_exits (id bigserial PRIMARY KEY, seat_id uuid, table_id uuid, user_id uuid, club_id uuid,
  seat_number integer, stack numeric, exit_kind text, db_role text, app_name text, occurred_at timestamptz);
CREATE TABLE public.tables (id uuid PRIMARY KEY, tournament_id uuid);
CREATE TABLE public.wallets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), balance numeric(15,2), updated_at timestamptz);
CREATE TABLE public.ca_frozen_pool_baseline (pool text PRIMARY KEY, frozen_total numeric);
CREATE TABLE public.ca_frozen_pool_deletions (id bigserial PRIMARY KEY, pool text, deleted_balance numeric);
CREATE TABLE public.tournaments (id uuid PRIMARY KEY, name text, status text, variant text, spin_multiplier numeric,
  buy_in_amount numeric, prize_pool numeric, ended_at timestamptz);
CREATE TABLE public.tournament_escrow (tournament_id uuid PRIMARY KEY, overlay_in numeric);
CREATE TABLE public.tournament_conservation_baseline (tournament_id uuid PRIMARY KEY, amount numeric);
CREATE TABLE public.tournament_payouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid, user_id uuid,
  position integer, amount numeric(15,2), source text, created_at timestamptz DEFAULT now(), idempotency_key text, paid_at timestamptz);
CREATE TABLE public.wallet_credit_idempotency (key text PRIMARY KEY, user_id uuid, amount numeric, created_at timestamptz);
CREATE INDEX idx_wallet_credit_idempotency_created ON public.wallet_credit_idempotency (created_at);
CREATE TABLE public.ca_detector_runs (id bigserial PRIMARY KEY, detector text, ran_at timestamptz DEFAULT clock_timestamp(), detail jsonb DEFAULT '{}');
CREATE TABLE public.test_incidents (source text, kind text, sev text, key text, detail jsonb);

CREATE FUNCTION public.fn_unpriced_tournaments(p interval)
 RETURNS TABLE(tournament_id uuid, name text, tournament_type text, buy_in_amount numeric, buy_in_fee numeric, entrants integer, uncollected numeric, created_at timestamptz)
 LANGUAGE sql STABLE AS $$ SELECT NULL::uuid, NULL::text, NULL::text, NULL::numeric, NULL::numeric, NULL::integer, 2.5::numeric, now() WHERE false $$;
CREATE FUNCTION public.fn_bot_flag_disagreement()
 RETURNS TABLE(memberships bigint, chips_held numeric, horses_mislabelled_human bigint, humans_mislabelled_bot bigint, note text)
 LANGUAGE sql STABLE AS $$ SELECT 0::bigint, 0::numeric, 0::bigint, 0::bigint, ''::text $$;
CREATE FUNCTION public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)
 RETURNS uuid LANGUAGE sql AS $$ INSERT INTO public.test_incidents VALUES ($1, $2, $3, $4, $21) RETURNING NULL::uuid $$;
