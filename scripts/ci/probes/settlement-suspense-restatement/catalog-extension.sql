-- Captured production shape added on top of scripts/ci/probes/must-be-zero-balance/catalog.sql
-- for the settlement_suspense restatement qualification (migration 20260926060005).
-- Column sets are the ones the correction writer, the detectors, the incident
-- surface and the balance fingerprint actually read or write; every table the
-- fingerprint names exists so a missing relation cannot pass as "unchanged".

-- The journal columns the correction writer writes and re-reads.
ALTER TABLE public.chip_ledger
  ADD COLUMN performed_by uuid,
  ADD COLUMN status text NOT NULL DEFAULT 'posted',
  ADD COLUMN idempotency_key text,
  ADD COLUMN metadata jsonb,
  ADD COLUMN actor_service text,
  ADD COLUMN tournament_id uuid,
  ADD COLUMN table_id uuid;
CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON public.chip_ledger (idempotency_key);
ALTER TABLE public.chip_ledger
  ADD CONSTRAINT chip_ledger_from_type_check CHECK (from_type = ANY (ARRAY['player_wallet','club_treasury','club_wallet','agent_wallet','union_bank','union_wallet','table_stack','prize_liability','bbj_pool','spin_reserve','settlement_suspense','system_mint','system_burn','issuance_reserve','chip_retirement','promo_wallet'])),
  ADD CONSTRAINT chip_ledger_to_type_check CHECK (to_type = ANY (ARRAY['player_wallet','club_treasury','club_wallet','agent_wallet','union_bank','union_wallet','table_stack','prize_liability','bbj_pool','spin_reserve','settlement_suspense','system_mint','system_burn','issuance_reserve','chip_retirement','promo_wallet']));

-- Production's ca_chip_store_coverage treatments for the stores used here.
CREATE TABLE public.ca_chip_store_coverage (
  store text PRIMARY KEY, treatment text NOT NULL, counted_by text, notes text,
  added_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.ca_chip_store_coverage (store, treatment, counted_by) VALUES
 ('agent_wallet','counted','agent_wallets'), ('bbj_pool','counted','bbj_pools'),
 ('chip_retirement','noncirculating',NULL), ('club_treasury','counted','treasuries'),
 ('club_wallet','counted','club_wallets'), ('issuance_reserve','noncirculating',NULL),
 ('player_wallet','counted','member_wallets + member_promo'),
 ('prize_liability','counted','tournament_liability'), ('promo_wallet','counted','promo'),
 ('settlement_suspense','uncounted',NULL), ('spin_reserve','counted','spin_pools'),
 ('system_burn','noncirculating',NULL), ('system_mint','noncirculating',NULL),
 ('table_stack','counted','felt'), ('union_bank','counted','union_wallets'),
 ('union_wallet','counted','union_wallets');

-- The incident surface as production has it: the closure vocabulary CHECK and
-- the resolution law trigger (installed-definitions.sql carries its function).
ALTER TABLE public.ca_drift_incidents ADD CONSTRAINT ca_drift_incidents_closure_basis_check
  CHECK (((closure_basis IS NULL) OR (closure_basis = ANY (ARRAY['verified_remeasured'::text, 'aged_out_unverified'::text, 'operator'::text, 'repair'::text]))));
ALTER TABLE public.ca_incident_events ADD COLUMN actor uuid, ADD COLUMN actor_label text;

CREATE TABLE public.ca_correction_request_intents_v1 (
  linkage_key text PRIMARY KEY,
  ledger_id uuid NOT NULL UNIQUE,
  request_intent jsonb NOT NULL CHECK ((jsonb_typeof(request_intent) = 'object') AND ((request_intent ->> 'version') = '1')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.ca_incident_recipients (user_id uuid, active boolean, scope text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text);
CREATE TABLE public.ca_ledger_write_failures (
  id bigserial PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(), club_id uuid,
  user_id uuid, delta numeric, sqlstate text, message text);

-- fn_ca_quick_reconcile's inputs, empty unless a case seeds them.
ALTER TABLE public.clubs ADD COLUMN chip_treasury numeric DEFAULT 0;
CREATE TABLE public.club_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, user_id uuid,
  chip_balance numeric DEFAULT 0, credit_limit numeric DEFAULT 0, promo_balance numeric DEFAULT 0);
CREATE TABLE public.union_wallets (union_id uuid PRIMARY KEY, chip_balance numeric DEFAULT 0,
  rake_wallet numeric DEFAULT 0, bbj_wallet numeric DEFAULT 0, promo_wallet numeric DEFAULT 0,
  insurance_wallet numeric DEFAULT 0, spin_reserve_wallet numeric DEFAULT 0);
CREATE TABLE public.agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, club_id uuid,
  agent_wallet_balance numeric DEFAULT 0, promo_wallet_balance numeric DEFAULT 0);
CREATE TABLE public.bbj_pools (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid,
  main_balance numeric DEFAULT 0, backup_balance numeric DEFAULT 0, promo_balance numeric DEFAULT 0,
  pool_amount numeric DEFAULT 0);
CREATE TABLE public.ca_frozen_pool_baseline (pool text PRIMARY KEY, frozen_total numeric);
CREATE TABLE public.wallets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), balance numeric DEFAULT 0,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.ca_frozen_pool_deletions (pool text, deleted_balance numeric);
CREATE TABLE public.settlement_idempotency_keys (table_id uuid, hand_id uuid, status text,
  first_attempt_at timestamptz, last_attempt_at timestamptz);
CREATE TABLE public.union_pnl_settlements (id uuid PRIMARY KEY, union_id uuid, period_start timestamptz,
  period_end timestamptz, status text, settled_at timestamptz);
CREATE FUNCTION public.fn_unaccounted_seat_exits(interval, interval)
 RETURNS TABLE(exit_id uuid, stack numeric, user_id uuid, club_id uuid, table_id uuid, exit_kind text)
 LANGUAGE sql AS $$SELECT NULL::uuid, NULL::numeric, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text WHERE false$$;

-- The rest of the balance-bearing tables the no-chips-move fingerprint reads.
CREATE TABLE public.club_wallets (club_id uuid PRIMARY KEY, chip_balance numeric DEFAULT 0, insurance_balance numeric DEFAULT 0);
CREATE TABLE public.spin_bonus_pools (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, balance numeric DEFAULT 0);
CREATE TABLE public.tournament_escrow (tournament_id uuid PRIMARY KEY, prize_balance numeric DEFAULT 0, bounty_balance numeric DEFAULT 0, fee_balance numeric DEFAULT 0);
CREATE TABLE public.table_seats (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid, user_id uuid, stack numeric DEFAULT 0);
CREATE TABLE public.chip_escrow (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount numeric DEFAULT 0);
CREATE TABLE public.chip_escrow_holds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount numeric DEFAULT 0);
CREATE TABLE public.tournament_tickets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), value numeric DEFAULT 0);
CREATE TABLE public.club_opening_setups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), leaderboard_seed_remaining numeric DEFAULT 0);
ALTER TABLE public.tournaments ADD COLUMN prize_pool numeric DEFAULT 0;

-- Both guards this change redefines are on production's watchlist.
CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist() RETURNS text[]
 LANGUAGE sql IMMUTABLE AS $$SELECT ARRAY['fn_ca_suspense_regression_check','fn_ca_quick_reconcile']::text[]$$;
