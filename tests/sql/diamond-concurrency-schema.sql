-- ============================================================================
-- THE TABLES THE DIAMOND MONEY DOORS WRITE, IN PRODUCTION'S SHAPE
-- ============================================================================
--
-- Phase 11, line 2. A race is decided by the rows it writes: a unique index
-- is what makes the second of two identical requests wait for the first, a
-- constraint trigger is what refuses an unbound custody row at commit, and a
-- trigger chain is what keeps the register in step with every wallet. So the
-- tables the concurrency cases write must carry production's columns,
-- constraints, indexes and triggers, not the historical base's.
--
-- Every statement below was generated from production's own catalogue, read
-- read-only (pg_get_indexdef, pg_get_constraintdef, pg_get_triggerdef,
-- format_type, pg_get_expr), as the difference between production and this
-- fixture's base. Nothing is authored. The block at the foot renders each
-- table's full shape back out of this catalogue - every column with its type,
-- nullability and default, every constraint, index and trigger with its
-- enabled state, and the row-security flags - and refuses to finish unless
-- its md5 equals the signature production rendered for the same table.
--
-- Row-level security POLICIES are not part of the shape: every door here is
-- SECURITY DEFINER and runs as its owner, which no policy restricts.
-- ============================================================================
SET check_function_bodies = off;
SET search_path = public, extensions, pg_catalog;

-- Overloads the historical base carries under a captured door's name that production
-- does not have. Left in place they make production's own calls ambiguous.
DROP FUNCTION public.add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text, p_description text, p_reference_id text);
DROP FUNCTION public.fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb, p_dedupe_key text);
CREATE SEQUENCE IF NOT EXISTS smarter_private.f06_lifecycle_seq AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
CREATE SEQUENCE IF NOT EXISTS public.ca_diamond_balance_audit_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.poker_diamond_tournament_ledger_id_seq;
CREATE TABLE public.diamond_wallet_transfers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  request_id text NOT NULL,
  amount integer NOT NULL,
  message text,
  sender_journal_id uuid NOT NULL,
  recipient_journal_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.diamond_wallet_transfers ADD CONSTRAINT diamond_wallet_transfers_amount_check CHECK ((amount > 0));
ALTER TABLE public.diamond_wallet_transfers ADD CONSTRAINT diamond_wallet_transfers_check CHECK ((sender_id <> recipient_id));
ALTER TABLE public.diamond_wallet_transfers ADD CONSTRAINT diamond_wallet_transfers_pkey PRIMARY KEY (id);
ALTER TABLE public.diamond_wallet_transfers ADD CONSTRAINT diamond_wallet_transfers_sender_id_request_id_key UNIQUE (sender_id, request_id);
ALTER TABLE public.diamond_wallet_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diamond_wallet_transfers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.feature_purchases DROP CONSTRAINT IF EXISTS feature_purchases_source_check CASCADE;
ALTER TABLE public.feature_purchases ADD CONSTRAINT feature_purchases_source_check CHECK ((source = ANY (ARRAY['purchase'::text, 'daily_bonus'::text, 'promo_vault'::text, 'shop'::text, 'admin'::text, 'diamond_wheel'::text])));
ALTER TABLE public.poker_diamond_custody ADD COLUMN seat_id uuid;
ALTER TABLE public.poker_diamond_custody ADD COLUMN seat_joined_at timestamp with time zone;
ALTER TABLE public.poker_diamond_custody ADD COLUMN occupancy_id uuid;
ALTER TABLE public.poker_diamond_custody ADD CONSTRAINT poker_diamond_seat_identity_complete CHECK ((((seat_id IS NULL) AND (seat_joined_at IS NULL) AND (occupancy_id IS NULL)) OR ((purpose = 'cash_seat'::text) AND (seat_id IS NOT NULL) AND (seat_joined_at IS NOT NULL) AND (occupancy_id IS NOT NULL))));
ALTER TABLE public.poker_diamond_movements ALTER COLUMN wallet_journal_id DROP NOT NULL;
ALTER TABLE public.poker_diamond_movements DROP CONSTRAINT IF EXISTS poker_diamond_movements_amount_check CASCADE;
ALTER TABLE public.poker_diamond_movements ADD CONSTRAINT poker_diamond_movements_amount_check CHECK (((((amount >= 1) AND (amount <= 2147483647)) AND (wallet_journal_id IS NOT NULL)) OR ((action = 'release'::text) AND (amount = 0) AND (wallet_journal_id IS NULL))));
ALTER TABLE public.poker_diamond_lot_reservations ADD COLUMN consumed bigint DEFAULT 0 NOT NULL;
ALTER TABLE public.poker_diamond_lot_reservations ADD CONSTRAINT poker_diamond_lot_reservations_check CHECK (((consumed >= 0) AND (consumed <= amount)));
CREATE TABLE public.seat_cashout_receipts (
  occupancy_id uuid NOT NULL,
  user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  seat_number integer NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE public.seat_cashout_receipts ADD CONSTRAINT seat_cashout_receipts_pkey PRIMARY KEY (occupancy_id);
ALTER TABLE public.seat_cashout_receipts ADD CONSTRAINT seat_cashout_receipts_receipt_check CHECK ((jsonb_typeof(receipt) = 'object'::text));
ALTER TABLE public.seat_cashout_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seat_cashout_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.table_seats ADD COLUMN occupancy_id uuid DEFAULT gen_random_uuid() NOT NULL;
ALTER TABLE public.table_seats ADD COLUMN active_game_scope text;
ALTER TABLE public.table_seats ADD COLUMN active_parent_key text;
ALTER TABLE public.table_seats ADD CONSTRAINT active_seat_requires_game_scope CHECK ((((left_at IS NULL) AND (active_game_scope IS NOT NULL) AND (user_id IS NOT NULL) AND (table_id IS NOT NULL)) OR ((left_at IS NOT NULL) AND (active_game_scope IS NULL))));
ALTER TABLE public.table_seats ADD CONSTRAINT active_seat_requires_open_parent CHECK ((((left_at IS NULL) AND (active_parent_key IS NOT NULL) AND (active_parent_key <> 'closed'::text)) OR ((left_at IS NOT NULL) AND (active_parent_key IS NULL))));
ALTER TABLE public.table_seats ADD CONSTRAINT one_committed_seat_per_game_player UNIQUE (user_id, active_game_scope) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.tables ADD COLUMN observer_show_cards boolean DEFAULT false NOT NULL;
ALTER TABLE public.tables ADD COLUMN seat_game_scope text;
ALTER TABLE public.tables ADD COLUMN seat_admission_key text;
ALTER TABLE public.tables ADD COLUMN f06_lifecycle bigint DEFAULT smarter_private.f06_new_lifecycle() NOT NULL;
ALTER TABLE public.tables ADD COLUMN dealing_halted_at timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN dealing_halted_reason text;
ALTER TABLE public.tables ADD COLUMN kill_mode text DEFAULT 'off'::text NOT NULL;
ALTER TABLE public.tables ADD COLUMN kill_threshold_bb smallint DEFAULT 10 NOT NULL;
ALTER TABLE public.tables ADD COLUMN dealing_halt_observed_at timestamp with time zone;
ALTER TABLE public.tables DROP CONSTRAINT IF EXISTS tables_cash_needs_a_game CASCADE;
ALTER TABLE public.tables ADD CONSTRAINT table_game_scope_is_derived CHECK (((seat_game_scope IS NULL) OR (seat_game_scope =
CASE
    WHEN (cluster_id IS NULL) THEN ('table:'::text || (id)::text)
    ELSE ('cluster:'::text || (cluster_id)::text)
END)));
ALTER TABLE public.tables ADD CONSTRAINT table_game_scope_parent_key UNIQUE (id, seat_game_scope);
ALTER TABLE public.tables ADD CONSTRAINT table_seat_admission_is_derived CHECK (((seat_admission_key IS NULL) OR (seat_admission_key =
CASE
    WHEN ((lower(COALESCE(status, ''::text)) = ANY (ARRAY['closed'::text, 'completed'::text, 'cancelled'::text, 'finished'::text])) OR (lifecycle = 'closed'::text) OR COALESCE(is_deleted, false) OR COALESCE(is_template, false)) THEN 'closed'::text
    WHEN (tournament_id IS NOT NULL) THEN ('tournament:'::text || (tournament_id)::text)
    ELSE 'cash'::text
END)));
ALTER TABLE public.tables ADD CONSTRAINT table_seat_admission_parent_key UNIQUE (id, seat_admission_key);
ALTER TABLE public.tables ADD CONSTRAINT tables_cash_needs_a_game CHECK (((tournament_id IS NOT NULL) OR (cluster_id IS NOT NULL) OR (status = ANY (ARRAY['closed'::text, 'deleted'::text])) OR COALESCE(is_deleted, false) OR (club_id IS NULL) OR (game_variant IS NULL) OR (COALESCE(small_blind, (0)::numeric) <= (0)::numeric) OR (COALESCE(big_blind, (0)::numeric) <= COALESCE(small_blind, (0)::numeric)) OR (club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid)));
ALTER TABLE public.tables ADD CONSTRAINT tables_dealing_halt_is_explained CHECK ((((dealing_halted_at IS NULL) AND (dealing_halted_reason IS NULL)) OR ((dealing_halted_at IS NOT NULL) AND (dealing_halted_reason IS NOT NULL) AND (dealing_halted_reason = ANY (ARRAY['lightning_pending_on'::text, 'lightning'::text])))));
ALTER TABLE public.tables ADD CONSTRAINT tables_kill_mode_check CHECK ((kill_mode = ANY (ARRAY['off'::text, 'half'::text, 'full'::text]))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT tables_kill_threshold_bb_check CHECK ((kill_threshold_bb = ANY (ARRAY[8, 10, 12, 15]))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT tables_name_is_not_a_javascript_accident CHECK (((name IS NULL) OR ((name !~ 'undefined'::text) AND (name !~ 'NaN'::text) AND (name !~ '\[object'::text)))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT tables_stakes_is_not_a_javascript_accident CHECK (((stakes IS NULL) OR ((stakes !~ 'undefined'::text) AND (stakes !~ 'NaN'::text) AND (stakes !~ '\[object'::text) AND (stakes <> 'null/null'::text)))) NOT VALID;
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_has_no_fee CASCADE;
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_no_extra_rake CASCADE;
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_status_check CASCADE;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_spin_has_no_fee CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR (((lower(COALESCE(variant, ''::text)) <> 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric)))) NOT VALID;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_spin_no_extra_rake CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR ((variant IS DISTINCT FROM 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric))) NOT VALID;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_status_check CHECK ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text, 'LATE_REG'::text, 'RUNNING'::text, 'COMPLETING'::text, 'COMPLETED'::text, 'CANCELLED'::text, 'BAGGED'::text])));
ALTER TABLE public.poker_diamond_tournament_ledger DROP CONSTRAINT IF EXISTS poker_diamond_tournament_ledger_kind_check CASCADE;
ALTER TABLE public.poker_diamond_tournament_ledger DROP CONSTRAINT IF EXISTS poker_diamond_tournament_ledger_outflow CASCADE;
ALTER TABLE public.poker_diamond_tournament_ledger ADD CONSTRAINT poker_diamond_tournament_ledger_kind_check CHECK ((kind = ANY (ARRAY['entry'::text, 'rebuy'::text, 'reentry'::text, 'addon'::text, 'prize'::text, 'bounty'::text, 'fee'::text, 'refund'::text, 'spin_underwrite'::text, 'spin_surplus'::text])));
ALTER TABLE public.poker_diamond_tournament_ledger ADD CONSTRAINT poker_diamond_tournament_ledger_outflow CHECK ((((kind = ANY (ARRAY['prize'::text, 'bounty'::text, 'refund'::text])) AND (user_id IS NOT NULL)) OR ((kind = 'fee'::text) AND (user_id IS NULL) AND (prize_part = 0) AND (bounty_part = 0)) OR (kind = ANY (ARRAY['entry'::text, 'rebuy'::text, 'reentry'::text, 'addon'::text])) OR ((kind = ANY (ARRAY['spin_underwrite'::text, 'spin_surplus'::text])) AND (user_id IS NOT NULL) AND (custody_id IS NOT NULL) AND (wallet_journal_id IS NOT NULL) AND (prize_part = amount) AND (bounty_part = 0) AND (fee_part = 0))));
CREATE TABLE public.accounting_mixed_cutover_spin_fee_proofs (
  rake_record_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  cutover_at timestamp with time zone NOT NULL,
  original_batch jsonb NOT NULL,
  source_manifest jsonb NOT NULL,
  original_evidence jsonb NOT NULL,
  canonical_sources jsonb NOT NULL,
  qualified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  transaction_id xid8 DEFAULT pg_current_xact_id() NOT NULL
);
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ADD CONSTRAINT accounting_mixed_cutover_spin_fee_proof_canonical_sources_check CHECK (((jsonb_typeof(canonical_sources) = 'array'::text) AND (jsonb_array_length(canonical_sources) = 3)));
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ADD CONSTRAINT accounting_mixed_cutover_spin_fee_proof_original_evidence_check CHECK ((jsonb_typeof(original_evidence) = 'object'::text));
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ADD CONSTRAINT accounting_mixed_cutover_spin_fee_proofs_cutover_at_check CHECK (isfinite(cutover_at));
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ADD CONSTRAINT accounting_mixed_cutover_spin_fee_proofs_original_batch_check CHECK ((jsonb_typeof(original_batch) = 'object'::text));
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ADD CONSTRAINT accounting_mixed_cutover_spin_fee_proofs_pkey PRIMARY KEY (rake_record_id);
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ADD CONSTRAINT accounting_mixed_cutover_spin_fee_proofs_qualified_at_check CHECK (isfinite(qualified_at));
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ADD CONSTRAINT accounting_mixed_cutover_spin_fee_proofs_source_manifest_check CHECK ((jsonb_typeof(source_manifest) = 'object'::text));
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_fee_batches (
  rake_record_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  source_fingerprint text NOT NULL,
  status text DEFAULT 'captured'::text NOT NULL,
  source_version integer DEFAULT 2 NOT NULL,
  source_manifest jsonb,
  rake_amount numeric NOT NULL,
  captured_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL
);
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_check CHECK (((status = 'legacy_unverified'::text) OR (jsonb_typeof(source_manifest) = 'object'::text)));
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_pkey PRIMARY KEY (rake_record_id);
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_rake_amount_check CHECK (((rake_amount > (0)::numeric) AND (rake_amount = round(rake_amount, 2)) AND ((rake_amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_source_version_check CHECK ((source_version = 2));
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_status_check CHECK ((status = ANY (ARRAY['captured'::text, 'legacy_unverified'::text])));
ALTER TABLE public.accounting_tournament_fee_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_batches NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_fee_custody_obligations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tournament_id uuid NOT NULL,
  source_fingerprint text NOT NULL,
  amount numeric NOT NULL,
  reason text NOT NULL,
  original_fees jsonb NOT NULL,
  original_funding jsonb NOT NULL,
  original_scope jsonb NOT NULL,
  escrow_snapshot jsonb NOT NULL,
  held_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
  transaction_id bigint DEFAULT txid_current() NOT NULL
);
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT accounting_tournament_fee_custody_obli_source_fingerprint_check CHECK ((source_fingerprint ~ '^[0-9a-f]{32}$'::text));
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT accounting_tournament_fee_custody_obliga_original_funding_check CHECK ((jsonb_typeof(original_funding) = 'array'::text));
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT accounting_tournament_fee_custody_obligat_escrow_snapshot_check CHECK ((jsonb_typeof(escrow_snapshot) = 'object'::text));
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT accounting_tournament_fee_custody_obligati_original_scope_check CHECK ((jsonb_typeof(original_scope) = 'object'::text));
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT accounting_tournament_fee_custody_obligatio_original_fees_check CHECK ((jsonb_typeof(original_fees) = 'array'::text));
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT accounting_tournament_fee_custody_obligations_amount_check CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2)) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT accounting_tournament_fee_custody_obligations_pkey PRIMARY KEY (id);
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT accounting_tournament_fee_custody_obligations_reason_check CHECK ((reason = ANY (ARRAY['tournament_fee_sources_require_reconciliation'::text, 'accounting_terms_not_observed'::text, 'accounting_terms_not_active'::text, 'tournament_fee_not_captured_by_original_producer'::text])));
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT accounting_tournament_fee_custody_obligations_tournament_id_key UNIQUE (tournament_id);
ALTER TABLE public.accounting_tournament_fee_custody_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_custody_obligations NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_fee_custody_resolutions (
  tournament_id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  amount numeric NOT NULL,
  source_fingerprint text NOT NULL,
  original_plan jsonb NOT NULL,
  resolved_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
  transaction_id bigint DEFAULT txid_current() NOT NULL
);
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ADD CONSTRAINT accounting_tournament_fee_custody_reso_source_fingerprint_check CHECK ((source_fingerprint ~ '^[0-9a-f]{32}$'::text));
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ADD CONSTRAINT accounting_tournament_fee_custody_resolutio_original_plan_check CHECK ((jsonb_typeof(original_plan) = 'object'::text));
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ADD CONSTRAINT accounting_tournament_fee_custody_resolutions_amount_check CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2))));
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ADD CONSTRAINT accounting_tournament_fee_custody_resolutions_obligation_id_key UNIQUE (obligation_id);
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ADD CONSTRAINT accounting_tournament_fee_custody_resolutions_pkey PRIMARY KEY (tournament_id);
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_custody_resolutions NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_fee_cutover (
  singleton boolean DEFAULT true NOT NULL,
  starts_at timestamp with time zone NOT NULL
);
ALTER TABLE public.accounting_tournament_fee_cutover ADD CONSTRAINT accounting_tournament_fee_cutover_pkey PRIMARY KEY (singleton);
ALTER TABLE public.accounting_tournament_fee_cutover ADD CONSTRAINT accounting_tournament_fee_cutover_singleton_check CHECK (singleton);
ALTER TABLE public.accounting_tournament_fee_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_cutover NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_fee_recognitions (
  tournament_id uuid NOT NULL,
  recognized_at timestamp with time zone NOT NULL,
  status text NOT NULL,
  net_rake numeric NOT NULL,
  union_id uuid,
  bank_club_id uuid,
  union_wallet_transaction_id uuid,
  bank_journal_id uuid,
  source_fingerprint text NOT NULL,
  plan jsonb NOT NULL
);
ALTER TABLE public.accounting_tournament_fee_recognitions ADD CONSTRAINT accounting_tournament_fee_recog_union_wallet_transaction_id_key UNIQUE (union_wallet_transaction_id);
ALTER TABLE public.accounting_tournament_fee_recognitions ADD CONSTRAINT accounting_tournament_fee_recognitions_bank_journal_id_key UNIQUE (bank_journal_id);
ALTER TABLE public.accounting_tournament_fee_recognitions ADD CONSTRAINT accounting_tournament_fee_recognitions_check CHECK (((net_rake = (0)::numeric) OR (bank_club_id IS NOT NULL)));
ALTER TABLE public.accounting_tournament_fee_recognitions ADD CONSTRAINT accounting_tournament_fee_recognitions_check1 CHECK ((((net_rake = (0)::numeric) AND (union_wallet_transaction_id IS NULL) AND (bank_journal_id IS NULL)) OR ((net_rake > (0)::numeric) AND ((((union_wallet_transaction_id IS NOT NULL))::integer + ((bank_journal_id IS NOT NULL))::integer) = 1))));
ALTER TABLE public.accounting_tournament_fee_recognitions ADD CONSTRAINT accounting_tournament_fee_recognitions_net_rake_check CHECK (((net_rake >= (0)::numeric) AND (net_rake = round(net_rake, 2)) AND ((net_rake)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public.accounting_tournament_fee_recognitions ADD CONSTRAINT accounting_tournament_fee_recognitions_pkey PRIMARY KEY (tournament_id);
ALTER TABLE public.accounting_tournament_fee_recognitions ADD CONSTRAINT accounting_tournament_fee_recognitions_status_check CHECK ((status = ANY (ARRAY['recognized'::text, 'cancelled'::text, 'banked_accrual_deferred'::text])));
ALTER TABLE public.accounting_tournament_fee_recognitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_recognitions NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_fee_sources (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  rake_record_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  player_id uuid NOT NULL,
  club_id uuid NOT NULL,
  union_id uuid,
  coordinator_union_id uuid,
  game_type text NOT NULL,
  registration_id uuid NOT NULL,
  source_charge_ledger_id uuid NOT NULL,
  source_entitlement_id uuid NOT NULL,
  charged_at timestamp with time zone NOT NULL,
  rake_credit numeric NOT NULL,
  contract jsonb NOT NULL,
  recorded_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL
);
ALTER TABLE public.accounting_tournament_fee_sources ADD CONSTRAINT accounting_tournament_fee_sources_pkey PRIMARY KEY (id);
ALTER TABLE public.accounting_tournament_fee_sources ADD CONSTRAINT accounting_tournament_fee_sources_rake_credit_check CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public.accounting_tournament_fee_sources ADD CONSTRAINT accounting_tournament_fee_sources_rake_record_id_player_id_key UNIQUE (rake_record_id, player_id);
ALTER TABLE public.accounting_tournament_fee_sources ADD CONSTRAINT accounting_tournament_fee_sources_source_entitlement_id_key UNIQUE (source_entitlement_id);
ALTER TABLE public.accounting_tournament_fee_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_sources NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_recognized_sources (
  source_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  recognized_at timestamp with time zone NOT NULL,
  disposition text NOT NULL,
  rake_credit numeric NOT NULL
);
ALTER TABLE public.accounting_tournament_recognized_sources ADD CONSTRAINT accounting_tournament_recognized_sources_disposition_check CHECK ((disposition = ANY (ARRAY['earned'::text, 'refunded'::text])));
ALTER TABLE public.accounting_tournament_recognized_sources ADD CONSTRAINT accounting_tournament_recognized_sources_pkey PRIMARY KEY (source_id);
ALTER TABLE public.accounting_tournament_recognized_sources ADD CONSTRAINT accounting_tournament_recognized_sources_rake_credit_check CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public.accounting_tournament_recognized_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_recognized_sources NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.ca_ledger_maintenance_kinds (
  kind text NOT NULL,
  severity text DEFAULT 'warning'::text NOT NULL,
  note text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.ca_ledger_maintenance_kinds ADD CONSTRAINT ca_ledger_maintenance_kinds_pkey PRIMARY KEY (kind);
ALTER TABLE public.ca_ledger_maintenance_kinds ADD CONSTRAINT ca_ledger_maintenance_kinds_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])));
ALTER TABLE public.ca_ledger_maintenance_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_ledger_maintenance_kinds NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.cash_participant_funding_receipts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  operation_kind text NOT NULL,
  operation_key text,
  user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  occupancy_id uuid NOT NULL,
  seat_joined_at timestamp with time zone NOT NULL,
  source_ledger_id uuid NOT NULL,
  wallet_transaction_id uuid,
  account_type text NOT NULL,
  account_entity_id uuid NOT NULL,
  funding_club_id uuid NOT NULL,
  funding_union_id uuid,
  asset text NOT NULL,
  unit_scale integer DEFAULT 2 NOT NULL,
  amount numeric NOT NULL,
  balance_before numeric NOT NULL,
  balance_after numeric NOT NULL,
  pending_addon_id uuid,
  transaction_id xid8 DEFAULT pg_current_xact_id()
);
ALTER TABLE public.cash_participant_funding_receipts ADD CONSTRAINT cash_participant_funding_recei_operation_kind_operation_key_key UNIQUE (operation_kind, operation_key);
ALTER TABLE public.cash_participant_funding_receipts ADD CONSTRAINT cash_participant_funding_receipts_account_type_check CHECK ((account_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text])));
ALTER TABLE public.cash_participant_funding_receipts ADD CONSTRAINT cash_participant_funding_receipts_amount_check CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2)) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public.cash_participant_funding_receipts ADD CONSTRAINT cash_participant_funding_receipts_asset_check CHECK ((asset = 'chips'::text));
ALTER TABLE public.cash_participant_funding_receipts ADD CONSTRAINT cash_participant_funding_receipts_check CHECK (((balance_before - balance_after) = amount));
ALTER TABLE public.cash_participant_funding_receipts ADD CONSTRAINT cash_participant_funding_receipts_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['buyin'::text, 'rebuy'::text, 'addon'::text, 'horse_funding'::text])));
ALTER TABLE public.cash_participant_funding_receipts ADD CONSTRAINT cash_participant_funding_receipts_pending_addon_id_key UNIQUE (pending_addon_id);
ALTER TABLE public.cash_participant_funding_receipts ADD CONSTRAINT cash_participant_funding_receipts_pkey PRIMARY KEY (id);
ALTER TABLE public.cash_participant_funding_receipts ADD CONSTRAINT cash_participant_funding_receipts_source_ledger_id_key UNIQUE (source_ledger_id);
ALTER TABLE public.cash_participant_funding_receipts ADD CONSTRAINT cash_participant_funding_receipts_unit_scale_check CHECK ((unit_scale = 2));
ALTER TABLE public.cash_participant_funding_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_participant_funding_receipts NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.diamond_bonus_spin_tickets (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  bonus_date date NOT NULL,
  streak integer NOT NULL,
  entry_diamonds integer DEFAULT 100 NOT NULL,
  created_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
  club_id uuid,
  host_id uuid,
  host_kind text,
  owner_id uuid,
  commit_id uuid,
  client_seed text,
  mint_op_id text,
  funded_at timestamp with time zone,
  redeemed_spin_id uuid,
  redeemed_at timestamp with time zone
);
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_check CHECK ((((funded_at IS NULL) AND (club_id IS NULL) AND (host_id IS NULL) AND (host_kind IS NULL) AND (owner_id IS NULL) AND (commit_id IS NULL) AND (client_seed IS NULL) AND (mint_op_id IS NULL)) OR ((funded_at IS NOT NULL) AND (club_id IS NOT NULL) AND (host_id IS NOT NULL) AND (host_kind IS NOT NULL) AND (owner_id IS NOT NULL) AND (commit_id IS NOT NULL) AND (length(client_seed) > 0) AND (mint_op_id IS NOT NULL))));
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_check1 CHECK (((redeemed_spin_id IS NULL) = (redeemed_at IS NULL)));
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_check2 CHECK (((redeemed_spin_id IS NULL) OR (funded_at IS NOT NULL)));
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_claim_id_key UNIQUE (claim_id);
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_commit_id_key UNIQUE (commit_id);
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_entry_diamonds_check CHECK ((entry_diamonds = 100));
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_host_kind_check CHECK ((host_kind = ANY (ARRAY['union'::text, 'club'::text])));
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_mint_op_id_key UNIQUE (mint_op_id);
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_pkey PRIMARY KEY (id);
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_redeemed_spin_id_key UNIQUE (redeemed_spin_id);
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_streak_check CHECK (((streak > 0) AND ((streak % 10) = 0)));
ALTER TABLE public.diamond_bonus_spin_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diamond_bonus_spin_tickets NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.diamond_spin_days (
  owner_id uuid NOT NULL,
  day date NOT NULL,
  status text DEFAULT 'open'::text NOT NULL,
  pending_diamonds bigint DEFAULT 0 NOT NULL,
  entry_diamonds bigint DEFAULT 0 NOT NULL,
  bonus_diamonds bigint DEFAULT 0 NOT NULL,
  mint_entry_diamonds bigint DEFAULT 0 NOT NULL,
  diamond_prizes bigint DEFAULT 0 NOT NULL,
  throwables bigint DEFAULT 0 NOT NULL,
  time_banks bigint DEFAULT 0 NOT NULL,
  rabbit_hunts bigint DEFAULT 0 NOT NULL,
  other_expenses bigint DEFAULT 0 NOT NULL,
  movement_count bigint DEFAULT 0 NOT NULL,
  settled_net bigint,
  wallet_transaction_id uuid,
  notification_id uuid,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  settled_at timestamp with time zone,
  profit_burn_bps integer DEFAULT 0 NOT NULL,
  profit_burn bigint DEFAULT 0 NOT NULL,
  credited_net bigint GENERATED ALWAYS AS ((settled_net - profit_burn)) STORED
);
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_bonus_diamonds_check CHECK ((bonus_diamonds >= 0));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_check CHECK ((((status = 'open'::text) AND (settled_net IS NULL) AND (settled_at IS NULL) AND (wallet_transaction_id IS NULL) AND (notification_id IS NULL)) OR ((status = ANY (ARRAY['settling'::text, 'settled'::text])) AND (pending_diamonds = 0) AND (settled_net IS NOT NULL) AND (settled_at IS NOT NULL) AND (notification_id IS NOT NULL) AND ((settled_net = 0) OR (wallet_transaction_id IS NOT NULL)))));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_check1 CHECK ((
CASE
    WHEN (status = 'open'::text) THEN pending_diamonds
    ELSE settled_net
END = (((((((entry_diamonds + bonus_diamonds) + mint_entry_diamonds) - diamond_prizes) - throwables) - time_banks) - rabbit_hunts) - other_expenses)));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_diamond_prizes_check CHECK ((diamond_prizes >= 0));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_entry_diamonds_check CHECK ((entry_diamonds >= 0));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_mint_entry_diamonds_check CHECK ((mint_entry_diamonds >= 0));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_movement_count_check CHECK ((movement_count >= 0));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_other_expenses_check CHECK ((other_expenses >= 0));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_pending_diamonds_check CHECK (((pending_diamonds >= '-2147483647'::integer) AND (pending_diamonds <= 2147483647)));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_pkey PRIMARY KEY (owner_id, day);
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_profit_burn_bps_check CHECK (((profit_burn_bps >= 0) AND (profit_burn_bps <= 10000)));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_profit_burn_check CHECK ((profit_burn >= 0));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_profit_burn_identity CHECK ((((status = 'open'::text) AND (profit_burn_bps = 0) AND (profit_burn = 0)) OR ((status = ANY (ARRAY['settling'::text, 'settled'::text])) AND (profit_burn = fn_diamond_spin_profit_burn(settled_net, profit_burn_bps)))));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_rabbit_hunts_check CHECK ((rabbit_hunts >= 0));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_status_check CHECK ((status = ANY (ARRAY['open'::text, 'settling'::text, 'settled'::text])));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_throwables_check CHECK ((throwables >= 0));
ALTER TABLE public.diamond_spin_days ADD CONSTRAINT diamond_spin_days_time_banks_check CHECK ((time_banks >= 0));
ALTER TABLE public.diamond_spin_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diamond_spin_days NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.lightning_instance (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  cluster_id uuid NOT NULL,
  cluster_epoch integer NOT NULL,
  state text DEFAULT 'forming'::text NOT NULL,
  hand_id uuid,
  target_size smallint NOT NULL,
  max_size smallint NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  deadline_at timestamp with time zone DEFAULT (clock_timestamp() + '00:00:45'::interval) NOT NULL,
  abandon_reason text
);
ALTER TABLE public.lightning_instance ADD CONSTRAINT lightning_instance_abandon_is_explained CHECK ((((state <> 'abandoned'::text) AND (abandon_reason IS NULL)) OR ((state = 'abandoned'::text) AND (abandon_reason IS NOT NULL) AND (length(btrim(abandon_reason)) > 0))));
ALTER TABLE public.lightning_instance ADD CONSTRAINT lightning_instance_deadline_follows_creation CHECK ((deadline_at > created_at));
ALTER TABLE public.lightning_instance ADD CONSTRAINT lightning_instance_epoch_nonneg CHECK ((cluster_epoch >= 0));
ALTER TABLE public.lightning_instance ADD CONSTRAINT lightning_instance_identity UNIQUE (id, cluster_id, cluster_epoch);
ALTER TABLE public.lightning_instance ADD CONSTRAINT lightning_instance_lifecycle_order CHECK ((((started_at IS NULL) OR (started_at >= created_at)) AND ((completed_at IS NULL) OR ((started_at IS NOT NULL) AND (completed_at >= started_at)))));
ALTER TABLE public.lightning_instance ADD CONSTRAINT lightning_instance_pkey PRIMARY KEY (id);
ALTER TABLE public.lightning_instance ADD CONSTRAINT lightning_instance_sizes CHECK (((target_size >= 2) AND (max_size >= target_size) AND (max_size <= 9)));
ALTER TABLE public.lightning_instance ADD CONSTRAINT lightning_instance_state_check CHECK ((state = ANY (ARRAY['forming'::text, 'reserved'::text, 'dealing'::text, 'settling'::text, 'complete'::text, 'abandoned'::text])));
ALTER TABLE public.lightning_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lightning_instance NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.lightning_pool_session (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  cluster_id uuid NOT NULL,
  cluster_epoch integer NOT NULL,
  player_id uuid NOT NULL,
  cash_player_session_id uuid NOT NULL,
  state text DEFAULT 'joining'::text NOT NULL,
  entered_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  exited_at timestamp with time zone,
  exit_reason text,
  starting_stack numeric(14,2),
  ending_stack numeric(14,2),
  net_result numeric(14,2) DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  hands integer DEFAULT 0 NOT NULL,
  fast_folds integer DEFAULT 0 NOT NULL,
  normal_folds integer DEFAULT 0 NOT NULL,
  fold_and_watch integer DEFAULT 0 NOT NULL,
  showdowns integer DEFAULT 0 NOT NULL,
  hands_per_hour numeric(10,2) DEFAULT 0 NOT NULL,
  average_wait integer DEFAULT 0 NOT NULL,
  p95_wait integer DEFAULT 0 NOT NULL,
  p99_wait integer DEFAULT 0 NOT NULL,
  anchor_seat_id uuid NOT NULL
);
ALTER TABLE public.lightning_pool_session ADD CONSTRAINT lightning_pool_session_counters_are_not_negative CHECK (((hands >= 0) AND (fast_folds >= 0) AND (normal_folds >= 0) AND (fold_and_watch >= 0) AND (showdowns >= 0) AND (hands_per_hour >= (0)::numeric) AND (average_wait >= 0) AND (p95_wait >= 0) AND (p99_wait >= 0)));
ALTER TABLE public.lightning_pool_session ADD CONSTRAINT lightning_pool_session_epoch_nonneg CHECK ((cluster_epoch >= 0));
ALTER TABLE public.lightning_pool_session ADD CONSTRAINT lightning_pool_session_exit_is_explained CHECK ((((exited_at IS NULL) AND (exit_reason IS NULL)) OR ((exited_at IS NOT NULL) AND (exit_reason IS NOT NULL) AND (exited_at >= entered_at))));
ALTER TABLE public.lightning_pool_session ADD CONSTRAINT lightning_pool_session_identity UNIQUE (id, player_id, cluster_id, cluster_epoch);
ALTER TABLE public.lightning_pool_session ADD CONSTRAINT lightning_pool_session_pkey PRIMARY KEY (id);
ALTER TABLE public.lightning_pool_session ADD CONSTRAINT lightning_pool_session_state_check CHECK ((state = ANY (ARRAY['joining'::text, 'eligibility_check'::text, 'active'::text, 'sit_out'::text, 'disconnected'::text, 'leaving'::text, 'closed'::text])));
ALTER TABLE public.lightning_pool_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lightning_pool_session NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.lightning_pool_slot (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  pool_session_id uuid NOT NULL,
  cluster_id uuid NOT NULL,
  cluster_epoch integer NOT NULL,
  player_id uuid NOT NULL,
  slot smallint NOT NULL,
  opened_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  closed_at timestamp with time zone,
  close_reason text,
  hands integer DEFAULT 0 NOT NULL,
  fast_folds integer DEFAULT 0 NOT NULL,
  normal_folds integer DEFAULT 0 NOT NULL,
  fold_and_watch integer DEFAULT 0 NOT NULL,
  showdowns integer DEFAULT 0 NOT NULL,
  wait_total_ms bigint DEFAULT 0 NOT NULL,
  wait_samples integer DEFAULT 0 NOT NULL,
  p95_wait_ms integer,
  p99_wait_ms integer,
  hands_since_bb integer DEFAULT 0 NOT NULL,
  hands_since_sb integer DEFAULT 0 NOT NULL,
  last_bb_at timestamp with time zone,
  last_sb_at timestamp with time zone,
  last_button_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  idle_since timestamp with time zone NOT NULL
);
ALTER TABLE public.lightning_pool_slot ADD CONSTRAINT lightning_pool_slot_close_is_explained CHECK ((((closed_at IS NULL) AND (close_reason IS NULL)) OR ((closed_at IS NOT NULL) AND (close_reason IS NOT NULL) AND (closed_at >= opened_at))));
ALTER TABLE public.lightning_pool_slot ADD CONSTRAINT lightning_pool_slot_counters_nonneg CHECK (((hands >= 0) AND (fast_folds >= 0) AND (normal_folds >= 0) AND (fold_and_watch >= 0) AND (showdowns >= 0) AND (wait_total_ms >= 0) AND (wait_samples >= 0) AND (hands_since_bb >= 0) AND (hands_since_sb >= 0)));
ALTER TABLE public.lightning_pool_slot ADD CONSTRAINT lightning_pool_slot_epoch_nonneg CHECK ((cluster_epoch >= 0));
ALTER TABLE public.lightning_pool_slot ADD CONSTRAINT lightning_pool_slot_identity UNIQUE (id, player_id, cluster_id, cluster_epoch);
ALTER TABLE public.lightning_pool_slot ADD CONSTRAINT lightning_pool_slot_idle_since_follows_open CHECK ((idle_since >= opened_at));
ALTER TABLE public.lightning_pool_slot ADD CONSTRAINT lightning_pool_slot_pkey PRIMARY KEY (id);
ALTER TABLE public.lightning_pool_slot ADD CONSTRAINT lightning_pool_slot_range CHECK (((slot >= 1) AND (slot <= 24)));
ALTER TABLE public.lightning_pool_slot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lightning_pool_slot NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.lightning_reservation (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  cluster_id uuid NOT NULL,
  cluster_epoch integer NOT NULL,
  player_id uuid NOT NULL,
  pool_slot_id uuid NOT NULL,
  lightning_instance_id uuid NOT NULL,
  seat_number smallint,
  state text DEFAULT 'pending'::text NOT NULL,
  reason text,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  resolved_at timestamp with time zone
);
ALTER TABLE public.lightning_reservation ADD CONSTRAINT lightning_reservation_committed_names_its_instance CHECK (((state <> 'committed'::text) OR (lightning_instance_id IS NOT NULL)));
ALTER TABLE public.lightning_reservation ADD CONSTRAINT lightning_reservation_epoch_nonneg CHECK ((cluster_epoch >= 0));
ALTER TABLE public.lightning_reservation ADD CONSTRAINT lightning_reservation_expires_after_creation CHECK ((expires_at > created_at));
ALTER TABLE public.lightning_reservation ADD CONSTRAINT lightning_reservation_pkey PRIMARY KEY (id);
ALTER TABLE public.lightning_reservation ADD CONSTRAINT lightning_reservation_resolution CHECK ((((state = 'pending'::text) AND (resolved_at IS NULL)) OR ((state <> 'pending'::text) AND (resolved_at IS NOT NULL))));
ALTER TABLE public.lightning_reservation ADD CONSTRAINT lightning_reservation_seat_range CHECK (((seat_number IS NULL) OR ((seat_number >= 1) AND (seat_number <= 9))));
ALTER TABLE public.lightning_reservation ADD CONSTRAINT lightning_reservation_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'committed'::text, 'released'::text, 'expired'::text])));
ALTER TABLE public.lightning_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lightning_reservation NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.seat_admin_departure_authorizations (
  occupancy_id uuid NOT NULL,
  user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  seat_number integer NOT NULL,
  actor_id uuid NOT NULL,
  club_id uuid NOT NULL,
  reason text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.seat_admin_departure_authorizations ADD CONSTRAINT seat_admin_departure_authorizations_pkey PRIMARY KEY (occupancy_id);
ALTER TABLE public.seat_admin_departure_authorizations ADD CONSTRAINT seat_admin_departure_authorizations_reason_check CHECK (((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 2000)));
ALTER TABLE public.seat_admin_departure_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seat_admin_departure_authorizations NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.seat_departure_requests (
  occupancy_id uuid NOT NULL,
  user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  seat_number integer NOT NULL,
  leave_mode text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.seat_departure_requests ADD CONSTRAINT seat_departure_requests_leave_mode_check CHECK ((leave_mode = ANY (ARRAY['voluntary'::text, 'forced'::text])));
ALTER TABLE public.seat_departure_requests ADD CONSTRAINT seat_departure_requests_pkey PRIMARY KEY (occupancy_id);
ALTER TABLE public.seat_departure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seat_departure_requests NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.tournament_felt_supply_acknowledgements (
  tournament_id uuid NOT NULL,
  chips numeric NOT NULL,
  incident_id uuid,
  reason text NOT NULL,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.tournament_felt_supply_acknowledgements ADD CONSTRAINT tournament_felt_supply_acknowledgements_chips_check CHECK ((chips > (0)::numeric));
ALTER TABLE public.tournament_felt_supply_acknowledgements ADD CONSTRAINT tournament_felt_supply_acknowledgements_pkey PRIMARY KEY (tournament_id);
ALTER TABLE public.tournament_felt_supply_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_felt_supply_acknowledgements NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.tournament_paid_stack_custody_receipts (
  id uuid NOT NULL,
  transaction_id xid8 DEFAULT pg_current_xact_id() NOT NULL,
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  entitlement_id uuid NOT NULL,
  source_ledger_id uuid NOT NULL,
  source_wallet_id uuid NOT NULL,
  destination_table_id uuid NOT NULL,
  destination_seat_number integer NOT NULL,
  grant_chips numeric NOT NULL,
  live_chips_before numeric NOT NULL,
  funded_supply numeric NOT NULL,
  scoring_excess numeric NOT NULL,
  expected jsonb NOT NULL,
  state text NOT NULL,
  assignment jsonb,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  completed_at timestamp with time zone
);
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_rec_destination_seat_number_check CHECK (((destination_seat_number >= 1) AND (destination_seat_number <= 10)));
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_candidate_id_key UNIQUE (candidate_id);
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_check CHECK ((scoring_excess = ((live_chips_before + grant_chips) - funded_supply)));
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_check1 CHECK ((((state = 'reserved'::text) AND (assignment IS NULL) AND (completed_at IS NULL)) OR ((state = 'seated'::text) AND (assignment IS NOT NULL) AND (completed_at IS NOT NULL))));
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_entitlement_id_key UNIQUE (entitlement_id);
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_expected_check CHECK ((jsonb_typeof(expected) = 'object'::text));
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_funded_supply_check CHECK (((funded_supply > (0)::numeric) AND (funded_supply < 'Infinity'::numeric)));
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_grant_chips_check CHECK (((grant_chips > (0)::numeric) AND (grant_chips = trunc(grant_chips)) AND (grant_chips < ('2147483648'::bigint)::numeric)));
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_live_chips_before_check CHECK (((live_chips_before >= (0)::numeric) AND (live_chips_before < 'Infinity'::numeric)));
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_pkey PRIMARY KEY (id);
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_source_ledger_id_key UNIQUE (source_ledger_id);
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_source_wallet_id_key UNIQUE (source_wallet_id);
ALTER TABLE public.tournament_paid_stack_custody_receipts ADD CONSTRAINT tournament_paid_stack_custody_receipts_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'seated'::text])));
ALTER TABLE public.tournament_paid_stack_custody_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_paid_stack_custody_receipts NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.tournament_stage_resume_receipts (
  tournament_id uuid NOT NULL,
  stage_no integer NOT NULL,
  resume_id uuid NOT NULL,
  lease_generation uuid NOT NULL,
  schedule_generation bigint NOT NULL,
  first_level jsonb NOT NULL,
  claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  completed_at timestamp with time zone
);
ALTER TABLE public.tournament_stage_resume_receipts ADD CONSTRAINT tournament_stage_resume_receipts_first_level_check CHECK ((jsonb_typeof(first_level) = 'object'::text));
ALTER TABLE public.tournament_stage_resume_receipts ADD CONSTRAINT tournament_stage_resume_receipts_pkey PRIMARY KEY (tournament_id, stage_no);
ALTER TABLE public.tournament_stage_resume_receipts ADD CONSTRAINT tournament_stage_resume_receipts_resume_id_key UNIQUE (resume_id);
ALTER TABLE public.tournament_stage_resume_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_stage_resume_receipts NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.cash_cluster_epoch (
  cluster_id uuid NOT NULL,
  epoch integer NOT NULL,
  mode text NOT NULL,
  started_by text DEFAULT 'genesis'::text NOT NULL,
  started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  ended_at timestamp with time zone
);
ALTER TABLE public.cash_cluster_epoch ADD CONSTRAINT cash_cluster_epoch_ends_after_it_starts CHECK (((ended_at IS NULL) OR (ended_at >= started_at)));
ALTER TABLE public.cash_cluster_epoch ADD CONSTRAINT cash_cluster_epoch_mode_check CHECK ((mode = ANY (ARRAY['created'::text, 'opening'::text, 'must_move'::text, 'pending_on'::text, 'lightning'::text, 'pending_off'::text, 'draining'::text, 'paused'::text, 'frozen'::text, 'dead'::text])));
ALTER TABLE public.cash_cluster_epoch ADD CONSTRAINT cash_cluster_epoch_nonneg CHECK ((epoch >= 0));
ALTER TABLE public.cash_cluster_epoch ADD CONSTRAINT cash_cluster_epoch_pkey PRIMARY KEY (cluster_id, epoch);
ALTER TABLE public.cash_cluster_epoch ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_cluster_epoch NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.diamond_spin_movements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  operation_id text NOT NULL,
  owner_id uuid NOT NULL,
  day date NOT NULL,
  club_id uuid NOT NULL,
  host_id uuid NOT NULL,
  host_kind text NOT NULL,
  player_id uuid NOT NULL,
  kind text NOT NULL,
  amount integer NOT NULL,
  description text NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE public.diamond_spin_movements ADD CONSTRAINT diamond_spin_movements_amount_check CHECK ((amount <> 0));
ALTER TABLE public.diamond_spin_movements ADD CONSTRAINT diamond_spin_movements_check CHECK ((((kind = ANY (ARRAY['entry'::text, 'bonus'::text, 'mint_entry'::text])) AND (amount > 0)) OR ((kind <> ALL (ARRAY['entry'::text, 'bonus'::text, 'mint_entry'::text])) AND (amount < 0))));
ALTER TABLE public.diamond_spin_movements ADD CONSTRAINT diamond_spin_movements_host_kind_check CHECK ((host_kind = ANY (ARRAY['club'::text, 'union'::text])));
ALTER TABLE public.diamond_spin_movements ADD CONSTRAINT diamond_spin_movements_kind_check CHECK ((kind = ANY (ARRAY['entry'::text, 'bonus'::text, 'mint_entry'::text, 'diamond_prize'::text, 'throwable'::text, 'time_bank'::text, 'rabbit_hunt'::text, 'other_expense'::text])));
ALTER TABLE public.diamond_spin_movements ADD CONSTRAINT diamond_spin_movements_operation_id_check CHECK (((length(operation_id) >= 1) AND (length(operation_id) <= 200)));
ALTER TABLE public.diamond_spin_movements ADD CONSTRAINT diamond_spin_movements_operation_id_key UNIQUE (operation_id);
ALTER TABLE public.diamond_spin_movements ADD CONSTRAINT diamond_spin_movements_pkey PRIMARY KEY (id);
ALTER TABLE public.diamond_spin_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diamond_spin_movements NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.lightning_hand (
  hand_id uuid NOT NULL,
  cluster_id uuid NOT NULL,
  cluster_epoch integer NOT NULL,
  lightning_instance_id uuid NOT NULL,
  formed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  settled_at timestamp with time zone,
  participants_locked_at timestamp with time zone,
  player_count smallint,
  rules_version text NOT NULL,
  matcher_version text NOT NULL,
  blind_algorithm_version text NOT NULL,
  lightning_version text NOT NULL,
  rake_version text NOT NULL,
  request_id uuid
);
ALTER TABLE public.lightning_hand ADD CONSTRAINT lightning_hand_epoch_nonneg CHECK ((cluster_epoch >= 0));
ALTER TABLE public.lightning_hand ADD CONSTRAINT lightning_hand_identity UNIQUE (hand_id, cluster_id, cluster_epoch);
ALTER TABLE public.lightning_hand ADD CONSTRAINT lightning_hand_lock_counts_its_set CHECK ((((participants_locked_at IS NULL) AND (player_count IS NULL)) OR ((participants_locked_at IS NOT NULL) AND (player_count IS NOT NULL) AND (player_count >= 2) AND (player_count <= 9) AND (participants_locked_at >= formed_at))));
ALTER TABLE public.lightning_hand ADD CONSTRAINT lightning_hand_pkey PRIMARY KEY (hand_id);
ALTER TABLE public.lightning_hand ADD CONSTRAINT lightning_hand_settles_after_formation CHECK (((settled_at IS NULL) OR (settled_at >= formed_at)));
ALTER TABLE public.lightning_hand ADD CONSTRAINT lightning_hand_versions_are_named CHECK (((rules_version IS NOT NULL) AND (length(btrim(rules_version)) > 0) AND (matcher_version IS NOT NULL) AND (length(btrim(matcher_version)) > 0) AND (blind_algorithm_version IS NOT NULL) AND (length(btrim(blind_algorithm_version)) > 0) AND (lightning_version IS NOT NULL) AND (length(btrim(lightning_version)) > 0) AND (rake_version IS NOT NULL) AND (length(btrim(rake_version)) > 0)));
ALTER TABLE public.lightning_hand ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lightning_hand NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.lightning_hand_player (
  hand_id uuid NOT NULL,
  player_id uuid NOT NULL,
  pool_slot_id uuid NOT NULL,
  seat smallint NOT NULL,
  position text,
  blind_role text,
  stack_before numeric(14,2),
  stack_after numeric(14,2),
  fold_type text DEFAULT 'none'::text NOT NULL,
  cluster_id uuid NOT NULL,
  cluster_epoch integer NOT NULL
);
ALTER TABLE public.lightning_hand_player ADD CONSTRAINT lightning_hand_player_blind_role_check CHECK (((blind_role IS NULL) OR (blind_role = ANY (ARRAY['none'::text, 'sb'::text, 'bb'::text, 'both'::text, 'dead_sb'::text, 'straddle'::text]))));
ALTER TABLE public.lightning_hand_player ADD CONSTRAINT lightning_hand_player_epoch_nonneg CHECK ((cluster_epoch >= 0));
ALTER TABLE public.lightning_hand_player ADD CONSTRAINT lightning_hand_player_fold_type_check CHECK ((fold_type = ANY (ARRAY['none'::text, 'normal'::text, 'fast'::text, 'fold_watch'::text])));
ALTER TABLE public.lightning_hand_player ADD CONSTRAINT lightning_hand_player_pkey PRIMARY KEY (hand_id, player_id);
ALTER TABLE public.lightning_hand_player ADD CONSTRAINT lightning_hand_player_position_check CHECK ((("position" IS NULL) OR ("position" = ANY (ARRAY['utg'::text, 'utg1'::text, 'utg2'::text, 'lj'::text, 'hj'::text, 'co'::text, 'btn'::text, 'sb'::text, 'bb'::text]))));
ALTER TABLE public.lightning_hand_player ADD CONSTRAINT lightning_hand_player_seat_range CHECK (((seat >= 1) AND (seat <= 9)));
ALTER TABLE public.lightning_hand_player ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lightning_hand_player NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.tournament_stages (
  tournament_id uuid NOT NULL,
  stage_no integer NOT NULL,
  kind text NOT NULL,
  day_no integer NOT NULL,
  end_after_level integer,
  scheduled_start_utc timestamp with time zone,
  schedule_generation bigint DEFAULT 1 NOT NULL,
  state text DEFAULT 'planned'::text NOT NULL,
  state_changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE public.tournament_stages ADD CONSTRAINT tournament_stages_check CHECK ((day_no = stage_no));
ALTER TABLE public.tournament_stages ADD CONSTRAINT tournament_stages_check1 CHECK (((stage_no = 1) OR (scheduled_start_utc IS NOT NULL)));
ALTER TABLE public.tournament_stages ADD CONSTRAINT tournament_stages_end_after_level_check CHECK (((end_after_level IS NULL) OR (end_after_level >= 1)));
ALTER TABLE public.tournament_stages ADD CONSTRAINT tournament_stages_kind_check CHECK ((kind = 'day'::text));
ALTER TABLE public.tournament_stages ADD CONSTRAINT tournament_stages_pkey PRIMARY KEY (tournament_id, stage_no);
ALTER TABLE public.tournament_stages ADD CONSTRAINT tournament_stages_schedule_generation_check CHECK ((schedule_generation >= 1));
ALTER TABLE public.tournament_stages ADD CONSTRAINT tournament_stages_stage_no_check CHECK ((stage_no >= 1));
ALTER TABLE public.tournament_stages ADD CONSTRAINT tournament_stages_state_check CHECK ((state = ANY (ARRAY['planned'::text, 'running'::text, 'day_ending'::text, 'bagged'::text, 'scheduled'::text, 'resuming'::text, 'closed'::text])));
ALTER TABLE public.tournament_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_stages NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.tournament_stage_plans (
  tournament_id uuid NOT NULL,
  capability_id text NOT NULL,
  rule_version text NOT NULL,
  time_zone text NOT NULL,
  stage_count integer NOT NULL,
  plan jsonb NOT NULL,
  plan_hash text NOT NULL,
  sealed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  transaction_id xid8 DEFAULT pg_current_xact_id() NOT NULL
);
ALTER TABLE public.tournament_stage_plans ADD CONSTRAINT tournament_stage_plans_capability_id_check CHECK ((capability_id = 'tournament.multi_day.single_flight'::text));
ALTER TABLE public.tournament_stage_plans ADD CONSTRAINT tournament_stage_plans_pkey PRIMARY KEY (tournament_id);
ALTER TABLE public.tournament_stage_plans ADD CONSTRAINT tournament_stage_plans_plan_check CHECK ((jsonb_typeof(plan) = 'object'::text));
ALTER TABLE public.tournament_stage_plans ADD CONSTRAINT tournament_stage_plans_plan_hash_check CHECK ((plan_hash ~ '^[0-9a-f]{32}$'::text));
ALTER TABLE public.tournament_stage_plans ADD CONSTRAINT tournament_stage_plans_rule_version_check CHECK ((rule_version = 'multi-day-v1'::text));
ALTER TABLE public.tournament_stage_plans ADD CONSTRAINT tournament_stage_plans_stage_count_check CHECK (((stage_count >= 2) AND (stage_count <= 14)));
ALTER TABLE public.tournament_stage_plans ADD CONSTRAINT tournament_stage_plans_time_zone_check CHECK ((btrim(time_zone) <> ''::text));
ALTER TABLE public.tournament_stage_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_stage_plans NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.breakfast_original_witness (
  tournament_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  expected jsonb NOT NULL,
  expected_hash text NOT NULL,
  original_archive_sha256 text NOT NULL,
  original_line integer NOT NULL,
  original_observed_at timestamp with time zone NOT NULL,
  original_error text NOT NULL,
  original_place integer NOT NULL,
  original_prize numeric NOT NULL,
  target_postimage jsonb NOT NULL,
  admitted_xid bigint DEFAULT txid_current() NOT NULL,
  admitted_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL
);
ALTER TABLE smarter_private.breakfast_original_witness ADD CONSTRAINT breakfast_original_witness_check CHECK ((expected_hash = md5((expected)::text)));
ALTER TABLE smarter_private.breakfast_original_witness ADD CONSTRAINT breakfast_original_witness_operation_id_key UNIQUE (operation_id);
ALTER TABLE smarter_private.breakfast_original_witness ADD CONSTRAINT breakfast_original_witness_original_archive_sha256_check CHECK ((original_archive_sha256 = 'bec825a59f7ced2063d2ddc7c5d1859c30bbd1412178fc6535e25700d525366f'::text));
ALTER TABLE smarter_private.breakfast_original_witness ADD CONSTRAINT breakfast_original_witness_original_error_check CHECK ((original_error = 'TOURNAMENT_SEAT_ROSTER_REQUIRED'::text));
ALTER TABLE smarter_private.breakfast_original_witness ADD CONSTRAINT breakfast_original_witness_original_line_check CHECK ((original_line = 164263));
ALTER TABLE smarter_private.breakfast_original_witness ADD CONSTRAINT breakfast_original_witness_original_observed_at_check CHECK ((original_observed_at = '2026-09-08 14:28:11.325815+00'::timestamp with time zone));
ALTER TABLE smarter_private.breakfast_original_witness ADD CONSTRAINT breakfast_original_witness_original_place_check CHECK ((original_place = 21));
ALTER TABLE smarter_private.breakfast_original_witness ADD CONSTRAINT breakfast_original_witness_original_prize_check CHECK ((original_prize = (0)::numeric));
ALTER TABLE smarter_private.breakfast_original_witness ADD CONSTRAINT breakfast_original_witness_pkey PRIMARY KEY (tournament_id);
ALTER TABLE smarter_private.breakfast_original_witness ADD CONSTRAINT breakfast_original_witness_tournament_id_check CHECK ((tournament_id = 'f370585d-40ea-4085-bb8f-c7e8c74f3fb4'::uuid));
ALTER TABLE smarter_private.breakfast_original_witness ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.breakfast_original_witness NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_attempts (
  request_id uuid NOT NULL,
  break_id uuid NOT NULL,
  user_id uuid NOT NULL,
  revision integer NOT NULL,
  predecessor uuid,
  amendment_id uuid,
  amendment_payload jsonb,
  destination_table_id uuid NOT NULL,
  destination_seat_number integer NOT NULL,
  generation uuid NOT NULL,
  state text DEFAULT 'active'::text NOT NULL,
  receipt jsonb
);
ALTER TABLE smarter_private.f06_attempts ADD CONSTRAINT f06_attempts_amendment_id_key UNIQUE (amendment_id);
ALTER TABLE smarter_private.f06_attempts ADD CONSTRAINT f06_attempts_break_id_user_id_revision_key UNIQUE (break_id, user_id, revision);
ALTER TABLE smarter_private.f06_attempts ADD CONSTRAINT f06_attempts_check CHECK (((state = 'winner'::text) = (receipt IS NOT NULL)));
ALTER TABLE smarter_private.f06_attempts ADD CONSTRAINT f06_attempts_destination_seat_number_check CHECK (((destination_seat_number >= 1) AND (destination_seat_number <= 10)));
ALTER TABLE smarter_private.f06_attempts ADD CONSTRAINT f06_attempts_pkey PRIMARY KEY (request_id);
ALTER TABLE smarter_private.f06_attempts ADD CONSTRAINT f06_attempts_predecessor_key UNIQUE (predecessor);
ALTER TABLE smarter_private.f06_attempts ADD CONSTRAINT f06_attempts_revision_check CHECK ((revision > 0));
ALTER TABLE smarter_private.f06_attempts ADD CONSTRAINT f06_attempts_state_check CHECK ((state = ANY (ARRAY['active'::text, 'fenced'::text, 'winner'::text])));
ALTER TABLE smarter_private.f06_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_attempts NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_dispatch (
  request_id uuid NOT NULL,
  xid bigint NOT NULL,
  occupancy_id uuid NOT NULL,
  source_seat_id uuid NOT NULL,
  lifecycle bigint NOT NULL
);
ALTER TABLE smarter_private.f06_dispatch ADD CONSTRAINT f06_dispatch_pkey PRIMARY KEY (request_id);
ALTER TABLE smarter_private.f06_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_dispatch NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_elimination_dispatch (
  xid bigint NOT NULL,
  relation_name text NOT NULL,
  row_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  old_record jsonb NOT NULL,
  new_record jsonb NOT NULL
);
ALTER TABLE smarter_private.f06_elimination_dispatch ADD CONSTRAINT f06_elimination_dispatch_pkey PRIMARY KEY (xid, relation_name, row_id);
ALTER TABLE smarter_private.f06_elimination_dispatch ADD CONSTRAINT f06_elimination_dispatch_relation_name_check CHECK ((relation_name = ANY (ARRAY['tournament_players'::text, 'table_seats'::text])));
ALTER TABLE smarter_private.f06_elimination_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_elimination_dispatch NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_hand_dispatch (
  permit_id uuid NOT NULL,
  xid bigint NOT NULL
);
ALTER TABLE smarter_private.f06_hand_dispatch ADD CONSTRAINT f06_hand_dispatch_pkey PRIMARY KEY (permit_id);
ALTER TABLE smarter_private.f06_hand_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_hand_dispatch NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_hand_permits (
  permit_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  table_id uuid NOT NULL,
  lifecycle bigint NOT NULL,
  hand_number bigint NOT NULL,
  custody_id uuid NOT NULL,
  generation uuid NOT NULL,
  state text DEFAULT 'reserved'::text NOT NULL,
  evidence_id uuid
);
ALTER TABLE smarter_private.f06_hand_permits ADD CONSTRAINT f06_hand_permits_pkey PRIMARY KEY (permit_id);
ALTER TABLE smarter_private.f06_hand_permits ADD CONSTRAINT f06_hand_permits_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'accepted'::text, 'never_started'::text, 'aborted_unsettled'::text])));
ALTER TABLE smarter_private.f06_hand_permits ADD CONSTRAINT f06_hand_permits_table_id_hand_number_key UNIQUE (table_id, hand_number);
ALTER TABLE smarter_private.f06_hand_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_hand_permits NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_members (
  break_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_seat_id uuid NOT NULL,
  source_seat_number integer NOT NULL,
  occupancy_id uuid NOT NULL
);
ALTER TABLE smarter_private.f06_members ADD CONSTRAINT f06_members_break_id_source_seat_id_key UNIQUE (break_id, source_seat_id);
ALTER TABLE smarter_private.f06_members ADD CONSTRAINT f06_members_occupancy_id_key UNIQUE (occupancy_id);
ALTER TABLE smarter_private.f06_members ADD CONSTRAINT f06_members_pkey PRIMARY KEY (break_id, user_id);
ALTER TABLE smarter_private.f06_members ADD CONSTRAINT f06_members_source_seat_number_check CHECK (((source_seat_number >= 1) AND (source_seat_number <= 10)));
ALTER TABLE smarter_private.f06_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_members NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_movement_admissions (
  admission_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  lease_generation uuid NOT NULL,
  table_id uuid NOT NULL,
  lifecycle bigint NOT NULL,
  break_id uuid NOT NULL,
  custody_id uuid NOT NULL,
  revision bigint NOT NULL,
  requested_revision bigint NOT NULL,
  proof jsonb NOT NULL,
  proof_hash text NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE smarter_private.f06_movement_admissions ADD CONSTRAINT f06_movement_admissions_break_id_custody_id_key UNIQUE (break_id, custody_id);
ALTER TABLE smarter_private.f06_movement_admissions ADD CONSTRAINT f06_movement_admissions_lifecycle_check CHECK ((lifecycle > 0));
ALTER TABLE smarter_private.f06_movement_admissions ADD CONSTRAINT f06_movement_admissions_pkey PRIMARY KEY (admission_id);
ALTER TABLE smarter_private.f06_movement_admissions ADD CONSTRAINT f06_movement_admissions_proof_hash_check CHECK ((proof_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE smarter_private.f06_movement_admissions ADD CONSTRAINT f06_movement_admissions_requested_revision_check CHECK ((requested_revision >= 0));
ALTER TABLE smarter_private.f06_movement_admissions ADD CONSTRAINT f06_movement_admissions_revision_check CHECK ((revision > 0));
ALTER TABLE smarter_private.f06_movement_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_movement_admissions NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_operations (
  break_id uuid NOT NULL,
  ordinal bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  tournament_id uuid NOT NULL,
  source_table_id uuid NOT NULL,
  lifecycle bigint NOT NULL,
  boundary_id uuid NOT NULL,
  origin_generation uuid NOT NULL,
  state text DEFAULT 'park_requested'::text NOT NULL,
  manifest jsonb,
  revision bigint DEFAULT 0 NOT NULL,
  custody_id uuid,
  custody_generation uuid,
  cleanup_kind text,
  close_receipt jsonb,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  abort_receipt_id uuid
);
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_operations_boundary_id_key UNIQUE (boundary_id);
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_operations_check CHECK (((state = ANY (ARRAY['close_confirmed'::text, 'acknowledged'::text])) = (close_receipt IS NOT NULL)));
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_operations_ordinal_key UNIQUE (ordinal);
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_operations_pkey PRIMARY KEY (break_id);
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_operations_state_check CHECK ((state = ANY (ARRAY['park_requested'::text, 'begun'::text, 'close_confirmed'::text, 'acknowledged'::text, 'withdrawn_before_manifest'::text])));
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_withdrawal_has_no_manifest CHECK (((state <> 'withdrawn_before_manifest'::text) OR (manifest IS NULL)));
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_withdrawal_receipt CHECK (((state = 'withdrawn_before_manifest'::text) = (abort_receipt_id IS NOT NULL)));
ALTER TABLE smarter_private.f06_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_operations NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.spin_archived_first_admission (
  tournament_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  lease_generation uuid NOT NULL,
  owner_instance text NOT NULL,
  source_sha256 text NOT NULL,
  original_fee_proof jsonb NOT NULL,
  admitted_xid bigint DEFAULT txid_current() NOT NULL,
  admitted_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL
);
ALTER TABLE smarter_private.spin_archived_first_admission ADD CONSTRAINT spin_archived_first_admission_operation_id_key UNIQUE (operation_id);
ALTER TABLE smarter_private.spin_archived_first_admission ADD CONSTRAINT spin_archived_first_admission_pkey PRIMARY KEY (tournament_id);
ALTER TABLE smarter_private.spin_archived_first_admission ADD CONSTRAINT spin_archived_first_admission_source_sha256_check CHECK ((source_sha256 = '8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5'::text));
ALTER TABLE smarter_private.spin_archived_first_admission ADD CONSTRAINT spin_archived_first_admission_tournament_id_check CHECK ((tournament_id = '2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid));
ALTER TABLE smarter_private.spin_archived_first_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.spin_archived_first_admission NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.spin_original_standings (
  tournament_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  winner_id uuid NOT NULL,
  expected jsonb NOT NULL,
  expected_hash text NOT NULL,
  admitted_xid bigint DEFAULT txid_current() NOT NULL,
  admitted_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL
);
ALTER TABLE smarter_private.spin_original_standings ADD CONSTRAINT spin_original_standings_check CHECK ((expected_hash = md5((expected)::text)));
ALTER TABLE smarter_private.spin_original_standings ADD CONSTRAINT spin_original_standings_operation_id_key UNIQUE (operation_id);
ALTER TABLE smarter_private.spin_original_standings ADD CONSTRAINT spin_original_standings_pkey PRIMARY KEY (tournament_id);
ALTER TABLE smarter_private.spin_original_standings ADD CONSTRAINT spin_original_standings_tournament_id_check CHECK ((tournament_id = ANY (ARRAY['b60c7add-6b38-4549-b091-601f64d118a0'::uuid, '199a71a9-f364-4e90-a3ba-3cdcfb7755bc'::uuid, 'f3f050f1-569e-4fb6-859f-86b6092e682e'::uuid, '808ef798-0942-4ce0-9ae1-eeefaaf4b0a9'::uuid, 'e3f4e2ab-8397-43e8-8643-6cec3fff3a63'::uuid])));
ALTER TABLE smarter_private.spin_original_standings ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.spin_original_standings NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_generation_abort_hands (
  permit_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  generation uuid NOT NULL,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  snapshot_id uuid,
  break_id uuid,
  expected jsonb NOT NULL
);
ALTER TABLE smarter_private.f06_generation_abort_hands ADD CONSTRAINT f06_generation_abort_hands_break_id_key UNIQUE (break_id);
ALTER TABLE smarter_private.f06_generation_abort_hands ADD CONSTRAINT f06_generation_abort_hands_pkey PRIMARY KEY (permit_id);
ALTER TABLE smarter_private.f06_generation_abort_hands ADD CONSTRAINT f06_generation_abort_hands_snapshot_or_misdeal CHECK (((snapshot_id IS NOT NULL) OR ((expected ->> 'ruling'::text) = 'misdeal_voided'::text)));
ALTER TABLE smarter_private.f06_generation_abort_hands ADD CONSTRAINT f06_generation_abort_hands_table_id_hand_number_key UNIQUE (table_id, hand_number);
ALTER TABLE smarter_private.f06_generation_abort_hands ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_generation_abort_hands NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_manager_custody_admissions (
  transfer_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  generation uuid NOT NULL,
  lease_identity jsonb NOT NULL,
  terminal_proof jsonb NOT NULL,
  admitted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE smarter_private.f06_manager_custody_admissions ADD CONSTRAINT f06_manager_custody_admissions_pkey PRIMARY KEY (transfer_id);
ALTER TABLE smarter_private.f06_manager_custody_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_manager_custody_admissions NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_manager_custody_completions (
  transfer_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  generation uuid NOT NULL,
  admission jsonb NOT NULL,
  operation_receipts jsonb NOT NULL,
  presence_receipts jsonb NOT NULL,
  completed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE smarter_private.f06_manager_custody_completions ADD CONSTRAINT f06_manager_custody_completions_pkey PRIMARY KEY (transfer_id);
ALTER TABLE smarter_private.f06_manager_custody_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_manager_custody_completions NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_manager_custody_transfers (
  transfer_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  origin_generation uuid NOT NULL,
  successor_generation uuid NOT NULL,
  local_proof jsonb NOT NULL,
  canonical_proof jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE smarter_private.f06_manager_custody_transfers ADD CONSTRAINT f06_manager_custody_transfers_canonical_proof_check CHECK ((jsonb_typeof(canonical_proof) = 'object'::text));
ALTER TABLE smarter_private.f06_manager_custody_transfers ADD CONSTRAINT f06_manager_custody_transfers_check CHECK ((origin_generation <> successor_generation));
ALTER TABLE smarter_private.f06_manager_custody_transfers ADD CONSTRAINT f06_manager_custody_transfers_local_proof_check CHECK ((jsonb_typeof(local_proof) = 'object'::text));
ALTER TABLE smarter_private.f06_manager_custody_transfers ADD CONSTRAINT f06_manager_custody_transfers_pkey PRIMARY KEY (transfer_id);
ALTER TABLE smarter_private.f06_manager_custody_transfers ADD CONSTRAINT f06_manager_custody_transfers_tournament_id_origin_generati_key UNIQUE (tournament_id, origin_generation);
ALTER TABLE smarter_private.f06_manager_custody_transfers ADD CONSTRAINT f06_manager_custody_transfers_tournament_id_successor_gener_key UNIQUE (tournament_id, successor_generation);
ALTER TABLE smarter_private.f06_manager_custody_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_manager_custody_transfers NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_mixed_abort_hands (
  permit_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  generation uuid NOT NULL,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  snapshot_id uuid,
  break_id uuid,
  prior_hand_id uuid,
  prior_abort_receipt_id uuid,
  expected jsonb NOT NULL
);
ALTER TABLE smarter_private.f06_mixed_abort_hands ADD CONSTRAINT f06_mixed_abort_hands_break_id_key UNIQUE (break_id);
ALTER TABLE smarter_private.f06_mixed_abort_hands ADD CONSTRAINT f06_mixed_abort_hands_check CHECK ((((((snapshot_id IS NOT NULL))::integer + ((prior_hand_id IS NOT NULL))::integer) + ((prior_abort_receipt_id IS NOT NULL))::integer) = 1));
ALTER TABLE smarter_private.f06_mixed_abort_hands ADD CONSTRAINT f06_mixed_abort_hands_pkey PRIMARY KEY (permit_id);
ALTER TABLE smarter_private.f06_mixed_abort_hands ADD CONSTRAINT f06_mixed_abort_hands_table_id_hand_number_key UNIQUE (table_id, hand_number);
ALTER TABLE smarter_private.f06_mixed_abort_hands ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_mixed_abort_hands NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_no_start_continuations (
  receipt_id uuid DEFAULT gen_random_uuid() NOT NULL,
  break_id uuid NOT NULL,
  permit_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  table_id uuid NOT NULL,
  lifecycle bigint NOT NULL,
  hand_number bigint NOT NULL,
  original_generation uuid NOT NULL,
  current_generation uuid NOT NULL,
  park jsonb NOT NULL,
  permit jsonb NOT NULL,
  roster jsonb NOT NULL,
  prior_committed jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE smarter_private.f06_no_start_continuations ADD CONSTRAINT f06_no_start_continuations_break_id_key UNIQUE (break_id);
ALTER TABLE smarter_private.f06_no_start_continuations ADD CONSTRAINT f06_no_start_continuations_permit_id_key UNIQUE (permit_id);
ALTER TABLE smarter_private.f06_no_start_continuations ADD CONSTRAINT f06_no_start_continuations_pkey PRIMARY KEY (receipt_id);
ALTER TABLE smarter_private.f06_no_start_continuations ADD CONSTRAINT f06_no_start_continuations_table_id_hand_number_key UNIQUE (table_id, hand_number);
ALTER TABLE smarter_private.f06_no_start_continuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_no_start_continuations NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_unsettled_hand_aborts (
  receipt_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  table_id uuid NOT NULL,
  generation uuid NOT NULL,
  permit_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  break_id uuid NOT NULL,
  expected jsonb NOT NULL,
  outcome text DEFAULT 'aborted_unsettled'::text NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  retired_lease_generation uuid
);
ALTER TABLE smarter_private.f06_unsettled_hand_aborts ADD CONSTRAINT f06_abort_successor_distinct CHECK (((retired_lease_generation IS NULL) OR (retired_lease_generation <> generation)));
ALTER TABLE smarter_private.f06_unsettled_hand_aborts ADD CONSTRAINT f06_unsettled_hand_aborts_break_id_key UNIQUE (break_id);
ALTER TABLE smarter_private.f06_unsettled_hand_aborts ADD CONSTRAINT f06_unsettled_hand_aborts_outcome_check CHECK ((outcome = 'aborted_unsettled'::text));
ALTER TABLE smarter_private.f06_unsettled_hand_aborts ADD CONSTRAINT f06_unsettled_hand_aborts_permit_id_key UNIQUE (permit_id);
ALTER TABLE smarter_private.f06_unsettled_hand_aborts ADD CONSTRAINT f06_unsettled_hand_aborts_pkey PRIMARY KEY (receipt_id);
ALTER TABLE smarter_private.f06_unsettled_hand_aborts ADD CONSTRAINT f06_unsettled_hand_aborts_table_id_hand_number_key UNIQUE (table_id, hand_number);
ALTER TABLE smarter_private.f06_unsettled_hand_aborts ADD CONSTRAINT f06_unsettled_hand_aborts_tournament_id_generation_key UNIQUE (tournament_id, generation);
ALTER TABLE smarter_private.f06_unsettled_hand_aborts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_unsettled_hand_aborts NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.hand_submission_dispositions (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  permit_id uuid,
  disposition text NOT NULL,
  submission_id uuid
);
ALTER TABLE smarter_private.hand_submission_dispositions ADD CONSTRAINT hand_submission_dispositions_check CHECK (((disposition = 'retained'::text) = (submission_id IS NOT NULL)));
ALTER TABLE smarter_private.hand_submission_dispositions ADD CONSTRAINT hand_submission_dispositions_disposition_check CHECK ((disposition = ANY (ARRAY['retained'::text, 'disposed'::text])));
ALTER TABLE smarter_private.hand_submission_dispositions ADD CONSTRAINT hand_submission_dispositions_hand_number_check CHECK ((hand_number > 0));
ALTER TABLE smarter_private.hand_submission_dispositions ADD CONSTRAINT hand_submission_dispositions_permit_id_key UNIQUE (permit_id);
ALTER TABLE smarter_private.hand_submission_dispositions ADD CONSTRAINT hand_submission_dispositions_pkey PRIMARY KEY (table_id, hand_number);
ALTER TABLE smarter_private.hand_submission_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.hand_submission_dispositions NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_generation_aborts (
  receipt_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  generation uuid NOT NULL,
  expected jsonb NOT NULL,
  outcome text DEFAULT 'aborted_unsettled'::text NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE smarter_private.f06_generation_aborts ADD CONSTRAINT f06_generation_aborts_outcome_check CHECK ((outcome = 'aborted_unsettled'::text));
ALTER TABLE smarter_private.f06_generation_aborts ADD CONSTRAINT f06_generation_aborts_pkey PRIMARY KEY (receipt_id);
ALTER TABLE smarter_private.f06_generation_aborts ADD CONSTRAINT f06_generation_aborts_receipt_id_tournament_id_generation_key UNIQUE (receipt_id, tournament_id, generation);
ALTER TABLE smarter_private.f06_generation_aborts ADD CONSTRAINT f06_generation_aborts_tournament_id_generation_key UNIQUE (tournament_id, generation);
ALTER TABLE smarter_private.f06_generation_aborts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_generation_aborts NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_mixed_abort_generations (
  tournament_id uuid NOT NULL,
  generation uuid NOT NULL,
  receipt_id uuid NOT NULL
);
ALTER TABLE smarter_private.f06_mixed_abort_generations ADD CONSTRAINT f06_mixed_abort_generations_pkey PRIMARY KEY (tournament_id, generation);
ALTER TABLE smarter_private.f06_mixed_abort_generations ADD CONSTRAINT f06_mixed_abort_generations_receipt_id_tournament_id_genera_key UNIQUE (receipt_id, tournament_id, generation);
ALTER TABLE smarter_private.f06_mixed_abort_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_mixed_abort_generations NO FORCE ROW LEVEL SECURITY;
CREATE TABLE smarter_private.f06_mixed_aborts (
  receipt_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  expected jsonb NOT NULL,
  outcome text DEFAULT 'aborted_unsettled'::text NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE smarter_private.f06_mixed_aborts ADD CONSTRAINT f06_mixed_aborts_outcome_check CHECK ((outcome = 'aborted_unsettled'::text));
ALTER TABLE smarter_private.f06_mixed_aborts ADD CONSTRAINT f06_mixed_aborts_pkey PRIMARY KEY (receipt_id);
ALTER TABLE smarter_private.f06_mixed_aborts ADD CONSTRAINT f06_mixed_aborts_receipt_id_tournament_id_key UNIQUE (receipt_id, tournament_id);
ALTER TABLE smarter_private.f06_mixed_aborts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_mixed_aborts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cash_games ADD COLUMN cluster_mode text DEFAULT 'must_move'::text NOT NULL;
ALTER TABLE public.cash_games ADD COLUMN lightning_enabled boolean DEFAULT false NOT NULL;
ALTER TABLE public.cash_games ADD COLUMN cluster_epoch integer DEFAULT 0 NOT NULL;
ALTER TABLE public.cash_games ADD CONSTRAINT cash_games_cluster_epoch_nonneg CHECK ((cluster_epoch >= 0));
ALTER TABLE public.cash_games ADD CONSTRAINT cash_games_cluster_mode_check CHECK ((cluster_mode = ANY (ARRAY['created'::text, 'opening'::text, 'must_move'::text, 'pending_on'::text, 'lightning'::text, 'pending_off'::text, 'draining'::text, 'paused'::text, 'frozen'::text, 'dead'::text])));
ALTER TABLE public.tournament_participant_funding_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_transaction_frames ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.tournament_accounting_credit_receipts (
  transaction_id xid8 DEFAULT pg_current_xact_id() NOT NULL,
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  idempotency_key text NOT NULL,
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL,
  asset text NOT NULL,
  amount numeric NOT NULL,
  ledger_id uuid NOT NULL,
  wallet_transaction_id uuid NOT NULL,
  payout_id uuid,
  credited_club_id uuid NOT NULL,
  ledger_snapshot jsonb NOT NULL,
  wallet_snapshot jsonb NOT NULL,
  payout_snapshot jsonb,
  registration_snapshot jsonb,
  tournament_snapshot jsonb NOT NULL,
  entry_receipt_ids uuid[] NOT NULL
);
ALTER TABLE public.tournament_accounting_credit_receipts ADD CONSTRAINT tournament_accounting_credit_receipts_amount_check CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2)) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public.tournament_accounting_credit_receipts ADD CONSTRAINT tournament_accounting_credit_receipts_asset_check CHECK ((asset = 'chips'::text));
ALTER TABLE public.tournament_accounting_credit_receipts ADD CONSTRAINT tournament_accounting_credit_receipts_idempotency_key_key UNIQUE (idempotency_key);
ALTER TABLE public.tournament_accounting_credit_receipts ADD CONSTRAINT tournament_accounting_credit_receipts_ledger_id_key UNIQUE (ledger_id);
ALTER TABLE public.tournament_accounting_credit_receipts ADD CONSTRAINT tournament_accounting_credit_receipts_payout_id_key UNIQUE (payout_id);
ALTER TABLE public.tournament_accounting_credit_receipts ADD CONSTRAINT tournament_accounting_credit_receipts_pkey PRIMARY KEY (id);
ALTER TABLE public.tournament_accounting_credit_receipts ADD CONSTRAINT tournament_accounting_credit_receipts_wallet_transaction_id_key UNIQUE (wallet_transaction_id);
ALTER TABLE public.tournament_accounting_credit_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_accounting_credit_receipts NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.tournament_obligation_events (
  transaction_id xid8 DEFAULT pg_current_xact_id() NOT NULL,
  event_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  obligation_id uuid NOT NULL,
  asset text NOT NULL,
  tournament_id uuid NOT NULL,
  user_id uuid,
  operation text NOT NULL,
  before_row jsonb,
  after_row jsonb,
  tournament_snapshot jsonb NOT NULL,
  registration_snapshot jsonb,
  entry_receipt_ids uuid[] NOT NULL,
  credit_receipt_id uuid,
  refund_tranche_ids uuid[] NOT NULL
);
ALTER TABLE public.tournament_obligation_events ADD CONSTRAINT tournament_obligation_events_asset_check CHECK ((asset = ANY (ARRAY['chips'::text, 'diamonds'::text, 'unknown'::text])));
ALTER TABLE public.tournament_obligation_events ADD CONSTRAINT tournament_obligation_events_check CHECK ((((operation = 'INSERT'::text) AND (before_row IS NULL) AND (after_row IS NOT NULL)) OR ((operation = 'UPDATE'::text) AND (before_row IS NOT NULL) AND (after_row IS NOT NULL)) OR ((operation = 'DELETE'::text) AND (before_row IS NOT NULL) AND (after_row IS NULL))));
ALTER TABLE public.tournament_obligation_events ADD CONSTRAINT tournament_obligation_events_operation_check CHECK ((operation = ANY (ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text])));
ALTER TABLE public.tournament_obligation_events ADD CONSTRAINT tournament_obligation_events_pkey PRIMARY KEY (event_id);
ALTER TABLE public.tournament_obligation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_obligation_events NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.union_pnl_inventory_touches (
  event_id bigint NOT NULL,
  source_name text NOT NULL,
  row_id uuid NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  transaction_id xid8 NOT NULL,
  frame_observed_at timestamp with time zone,
  operation text NOT NULL,
  tournament_id text,
  union_id text
);
ALTER TABLE public.union_pnl_inventory_touches ADD CONSTRAINT union_pnl_inventory_touches_pkey PRIMARY KEY (event_id);
ALTER TABLE public.union_pnl_inventory_touches ADD CONSTRAINT union_pnl_inventory_touches_source_name_check CHECK ((source_name = ANY (ARRAY['tournament_players'::text, 'tournaments'::text])));
ALTER TABLE public.union_pnl_inventory_touches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_inventory_touches NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.union_pnl_credit_touches (
  id uuid NOT NULL,
  transaction_id xid8,
  frame_observed_at timestamp with time zone,
  union_id text
);
ALTER TABLE public.union_pnl_credit_touches ADD CONSTRAINT union_pnl_credit_touches_pkey PRIMARY KEY (id);
ALTER TABLE public.union_pnl_credit_touches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_credit_touches NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_invoice_deliveries (
  invoice_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  message_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  delivered_at timestamp with time zone DEFAULT now() NOT NULL,
  delivery_mode text DEFAULT 'immediate'::text NOT NULL
);
ALTER TABLE public.accounting_invoice_deliveries ADD CONSTRAINT accounting_invoice_deliveries_delivery_mode_check CHECK ((delivery_mode = ANY (ARRAY['immediate'::text, 'weekly_detail'::text])));
ALTER TABLE public.accounting_invoice_deliveries ADD CONSTRAINT accounting_invoice_deliveries_message_id_key UNIQUE (message_id);
ALTER TABLE public.accounting_invoice_deliveries ADD CONSTRAINT accounting_invoice_deliveries_notification_id_key UNIQUE (notification_id);
ALTER TABLE public.accounting_invoice_deliveries ADD CONSTRAINT accounting_invoice_deliveries_pkey PRIMARY KEY (invoice_id, recipient_id);
ALTER TABLE public.accounting_invoice_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_invoice_deliveries NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.operational_alert_events (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  source text NOT NULL,
  event_key text NOT NULL,
  alertname text NOT NULL,
  status text NOT NULL,
  severity text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  last_received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  delivery_count bigint DEFAULT 1 NOT NULL,
  investigation_status text DEFAULT 'new'::text NOT NULL,
  investigation jsonb DEFAULT '{}'::jsonb NOT NULL
);
ALTER TABLE public.operational_alert_events ADD CONSTRAINT operational_alert_events_alertname_check CHECK (((length(alertname) >= 1) AND (length(alertname) <= 240)));
ALTER TABLE public.operational_alert_events ADD CONSTRAINT operational_alert_events_event_key_check CHECK (((length(event_key) >= 1) AND (length(event_key) <= 512)));
ALTER TABLE public.operational_alert_events ADD CONSTRAINT operational_alert_events_investigation_status_check CHECK ((investigation_status = ANY (ARRAY['new'::text, 'investigating'::text, 'blocked'::text, 'verified_fixed'::text, 'historical'::text, 'test'::text])));
ALTER TABLE public.operational_alert_events ADD CONSTRAINT operational_alert_events_payload_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 262144)));
ALTER TABLE public.operational_alert_events ADD CONSTRAINT operational_alert_events_pkey PRIMARY KEY (id);
ALTER TABLE public.operational_alert_events ADD CONSTRAINT operational_alert_events_severity_check CHECK (((length(severity) >= 1) AND (length(severity) <= 40)));
ALTER TABLE public.operational_alert_events ADD CONSTRAINT operational_alert_events_source_check CHECK (((length(source) >= 1) AND (length(source) <= 120)));
ALTER TABLE public.operational_alert_events ADD CONSTRAINT operational_alert_events_source_event_key_key UNIQUE (source, event_key);
ALTER TABLE public.operational_alert_events ADD CONSTRAINT operational_alert_events_status_check CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text, 'info'::text])));
ALTER TABLE public.operational_alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_alert_events NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.operational_notification_destinations (
  notification_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  target_task_id uuid DEFAULT '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid NOT NULL,
  original_notification jsonb NOT NULL,
  inbox_event_id bigint,
  captured_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  last_attempt_at timestamp with time zone,
  last_error text
);
ALTER TABLE public.operational_notification_destinations ADD CONSTRAINT operational_notification_destinatio_original_notification_check CHECK ((jsonb_typeof(original_notification) = 'object'::text));
ALTER TABLE public.operational_notification_destinations ADD CONSTRAINT operational_notification_destinations_pkey PRIMARY KEY (notification_id);
ALTER TABLE public.operational_notification_destinations ADD CONSTRAINT operational_notification_destinations_recipient_user_id_check CHECK ((recipient_user_id = '47965354-0e56-43ef-931c-ddaab82af765'::uuid));
ALTER TABLE public.operational_notification_destinations ADD CONSTRAINT operational_notification_destinations_target_task_id_check CHECK ((target_task_id = '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid));
ALTER TABLE public.operational_notification_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_notification_destinations NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_fee_owner_bases (
  tournament_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  basis_kind text NOT NULL,
  hosting_club_id uuid NOT NULL,
  union_id uuid,
  completed_at timestamp with time zone NOT NULL,
  amount numeric NOT NULL,
  obligation_id uuid NOT NULL,
  source_fingerprint text NOT NULL,
  reason text NOT NULL,
  owner_instruction text NOT NULL,
  authorized_on date NOT NULL,
  created_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
  transaction_id bigint DEFAULT txid_current() NOT NULL
);
ALTER TABLE public.accounting_tournament_fee_owner_bases ADD CONSTRAINT accounting_tournament_fee_owner_bases_amount_check CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2))));
ALTER TABLE public.accounting_tournament_fee_owner_bases ADD CONSTRAINT accounting_tournament_fee_owner_bases_basis_kind_check CHECK ((basis_kind = 'owner_authorized_host_club_fee'::text));
ALTER TABLE public.accounting_tournament_fee_owner_bases ADD CONSTRAINT accounting_tournament_fee_owner_bases_owner_instruction_check CHECK ((length(owner_instruction) > 0));
ALTER TABLE public.accounting_tournament_fee_owner_bases ADD CONSTRAINT accounting_tournament_fee_owner_bases_pkey PRIMARY KEY (tournament_id);
ALTER TABLE public.accounting_tournament_fee_owner_bases ADD CONSTRAINT accounting_tournament_fee_owner_bases_reason_check CHECK ((length(reason) > 0));
ALTER TABLE public.accounting_tournament_fee_owner_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_owner_bases NO FORCE ROW LEVEL SECURITY;
CREATE TABLE public.accounting_tournament_fee_owner_operations (
  operation_id uuid NOT NULL,
  basis_kind text NOT NULL,
  reason text NOT NULL,
  owner_instruction text NOT NULL,
  authorized_on date NOT NULL,
  events jsonb NOT NULL,
  event_count integer NOT NULL,
  amount numeric NOT NULL,
  executed_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
  transaction_id bigint DEFAULT txid_current() NOT NULL
);
ALTER TABLE public.accounting_tournament_fee_owner_operations ADD CONSTRAINT accounting_tournament_fee_owner_operati_owner_instruction_check CHECK ((length(owner_instruction) > 0));
ALTER TABLE public.accounting_tournament_fee_owner_operations ADD CONSTRAINT accounting_tournament_fee_owner_operations_amount_check CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2))));
ALTER TABLE public.accounting_tournament_fee_owner_operations ADD CONSTRAINT accounting_tournament_fee_owner_operations_basis_kind_check CHECK ((basis_kind = 'owner_authorized_host_club_fee'::text));
ALTER TABLE public.accounting_tournament_fee_owner_operations ADD CONSTRAINT accounting_tournament_fee_owner_operations_event_count_check CHECK ((event_count > 0));
ALTER TABLE public.accounting_tournament_fee_owner_operations ADD CONSTRAINT accounting_tournament_fee_owner_operations_events_check CHECK (((jsonb_typeof(events) = 'array'::text) AND (jsonb_array_length(events) > 0)));
ALTER TABLE public.accounting_tournament_fee_owner_operations ADD CONSTRAINT accounting_tournament_fee_owner_operations_pkey PRIMARY KEY (operation_id);
ALTER TABLE public.accounting_tournament_fee_owner_operations ADD CONSTRAINT accounting_tournament_fee_owner_operations_reason_check CHECK ((length(reason) > 0));
ALTER TABLE public.accounting_tournament_fee_owner_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_owner_operations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ADD CONSTRAINT accounting_mixed_cutover_spin_fee_proofs_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES accounting_tournament_fee_batches(rake_record_id);
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ADD CONSTRAINT accounting_mixed_cutover_spin_fee_proofs_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id);
ALTER TABLE public.accounting_tournament_fee_batches ADD CONSTRAINT accounting_tournament_fee_batches_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES rake_records(id);
ALTER TABLE public.accounting_tournament_fee_recognitions ADD CONSTRAINT accounting_tournament_fee_reco_union_wallet_transaction_id_fkey FOREIGN KEY (union_wallet_transaction_id) REFERENCES union_wallet_transactions(id);
ALTER TABLE public.accounting_tournament_fee_recognitions ADD CONSTRAINT accounting_tournament_fee_recognitions_bank_journal_id_fkey FOREIGN KEY (bank_journal_id) REFERENCES chip_ledger(id);
ALTER TABLE public.accounting_tournament_fee_sources ADD CONSTRAINT accounting_tournament_fee_sources_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES accounting_tournament_fee_batches(rake_record_id);
ALTER TABLE public.accounting_tournament_recognized_sources ADD CONSTRAINT accounting_tournament_recognized_sources_source_id_fkey FOREIGN KEY (source_id) REFERENCES accounting_tournament_fee_sources(id);
ALTER TABLE public.accounting_tournament_recognized_sources ADD CONSTRAINT accounting_tournament_recognized_sources_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES accounting_tournament_fee_recognitions(tournament_id);
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_claim_fk FOREIGN KEY (claim_id) REFERENCES ca_daily_bonus_claims(id);
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_spin_fk FOREIGN KEY (redeemed_spin_id) REFERENCES wheel_spins(id);
ALTER TABLE public.diamond_bonus_spin_tickets ADD CONSTRAINT diamond_bonus_spin_tickets_user_fk FOREIGN KEY (user_id) REFERENCES profiles(id);
ALTER TABLE public.lightning_instance ADD CONSTRAINT lightning_instance_runs_in_a_declared_epoch FOREIGN KEY (cluster_id, cluster_epoch) REFERENCES cash_cluster_epoch(cluster_id, epoch) ON DELETE RESTRICT;
ALTER TABLE public.lightning_pool_session ADD CONSTRAINT lightning_pool_session_runs_in_a_declared_epoch FOREIGN KEY (cluster_id, cluster_epoch) REFERENCES cash_cluster_epoch(cluster_id, epoch) ON DELETE RESTRICT;
ALTER TABLE public.lightning_pool_slot ADD CONSTRAINT lightning_pool_slot_belongs_to_its_session FOREIGN KEY (pool_session_id, player_id, cluster_id, cluster_epoch) REFERENCES lightning_pool_session(id, player_id, cluster_id, cluster_epoch) ON DELETE RESTRICT;
ALTER TABLE public.lightning_reservation ADD CONSTRAINT lightning_reservation_belongs_to_its_slot FOREIGN KEY (pool_slot_id, player_id, cluster_id, cluster_epoch) REFERENCES lightning_pool_slot(id, player_id, cluster_id, cluster_epoch) ON DELETE CASCADE;
ALTER TABLE public.tournament_felt_supply_acknowledgements ADD CONSTRAINT tournament_felt_supply_acknowledgements_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
ALTER TABLE public.tournament_stage_resume_receipts ADD CONSTRAINT tournament_stage_resume_receipts_tournament_id_stage_no_fkey FOREIGN KEY (tournament_id, stage_no) REFERENCES tournament_stages(tournament_id, stage_no) ON DELETE RESTRICT;
ALTER TABLE public.cash_cluster_epoch ADD CONSTRAINT cash_cluster_epoch_belongs_to_a_cluster FOREIGN KEY (cluster_id) REFERENCES cash_games(id) ON DELETE CASCADE;
ALTER TABLE public.diamond_spin_movements ADD CONSTRAINT diamond_spin_movements_owner_id_day_fkey FOREIGN KEY (owner_id, day) REFERENCES diamond_spin_days(owner_id, day);
ALTER TABLE public.lightning_hand ADD CONSTRAINT lightning_hand_belongs_to_its_instance FOREIGN KEY (lightning_instance_id, cluster_id, cluster_epoch) REFERENCES lightning_instance(id, cluster_id, cluster_epoch) ON DELETE RESTRICT;
ALTER TABLE public.lightning_hand_player ADD CONSTRAINT lightning_hand_player_belongs_to_its_hand FOREIGN KEY (hand_id, cluster_id, cluster_epoch) REFERENCES lightning_hand(hand_id, cluster_id, cluster_epoch) ON DELETE RESTRICT;
ALTER TABLE public.lightning_hand_player ADD CONSTRAINT lightning_hand_player_sits_in_its_own_slot FOREIGN KEY (pool_slot_id, player_id, cluster_id, cluster_epoch) REFERENCES lightning_pool_slot(id, player_id, cluster_id, cluster_epoch) ON DELETE RESTRICT;
ALTER TABLE public.tournament_stages ADD CONSTRAINT tournament_stages_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournament_stage_plans(tournament_id) ON DELETE RESTRICT;
ALTER TABLE public.tournament_stage_plans ADD CONSTRAINT tournament_stage_plans_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE RESTRICT;
ALTER TABLE smarter_private.f06_attempts ADD CONSTRAINT f06_attempts_break_id_user_id_fkey FOREIGN KEY (break_id, user_id) REFERENCES smarter_private.f06_members(break_id, user_id);
ALTER TABLE smarter_private.f06_attempts ADD CONSTRAINT f06_attempts_predecessor_fkey FOREIGN KEY (predecessor) REFERENCES smarter_private.f06_attempts(request_id);
ALTER TABLE smarter_private.f06_dispatch ADD CONSTRAINT f06_dispatch_request_id_fkey FOREIGN KEY (request_id) REFERENCES smarter_private.f06_attempts(request_id);
ALTER TABLE smarter_private.f06_hand_dispatch ADD CONSTRAINT f06_hand_dispatch_permit_id_fkey FOREIGN KEY (permit_id) REFERENCES smarter_private.f06_hand_permits(permit_id);
ALTER TABLE smarter_private.f06_hand_permits ADD CONSTRAINT f06_hand_permits_table_id_fkey FOREIGN KEY (table_id) REFERENCES tables(id);
ALTER TABLE smarter_private.f06_members ADD CONSTRAINT f06_members_break_id_fkey FOREIGN KEY (break_id) REFERENCES smarter_private.f06_operations(break_id);
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_operations_source_table_id_fkey FOREIGN KEY (source_table_id) REFERENCES tables(id);
ALTER TABLE smarter_private.f06_generation_abort_hands ADD CONSTRAINT f06_generation_abort_hands_receipt_id_tournament_id_genera_fkey FOREIGN KEY (receipt_id, tournament_id, generation) REFERENCES smarter_private.f06_generation_aborts(receipt_id, tournament_id, generation);
ALTER TABLE smarter_private.f06_mixed_abort_hands ADD CONSTRAINT f06_mixed_abort_hands_receipt_id_tournament_id_generation_fkey FOREIGN KEY (receipt_id, tournament_id, generation) REFERENCES smarter_private.f06_mixed_abort_generations(receipt_id, tournament_id, generation);
ALTER TABLE smarter_private.f06_mixed_abort_generations ADD CONSTRAINT f06_mixed_abort_generations_receipt_id_tournament_id_fkey FOREIGN KEY (receipt_id, tournament_id) REFERENCES smarter_private.f06_mixed_aborts(receipt_id, tournament_id);
ALTER TABLE public.accounting_invoice_deliveries ADD CONSTRAINT accounting_invoice_deliveries_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES settlement_invoices(id);
ALTER TABLE public.accounting_invoice_deliveries ADD CONSTRAINT accounting_invoice_deliveries_message_id_fkey FOREIGN KEY (message_id) REFERENCES social_messages(id);
ALTER TABLE public.accounting_invoice_deliveries ADD CONSTRAINT accounting_invoice_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES notifications(id);
ALTER TABLE public.accounting_invoice_deliveries ADD CONSTRAINT accounting_invoice_deliveries_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES profiles(id);
ALTER TABLE public.operational_notification_destinations ADD CONSTRAINT operational_notification_destinations_inbox_event_id_fkey FOREIGN KEY (inbox_event_id) REFERENCES operational_alert_events(id);
ALTER TABLE public.accounting_tournament_fee_owner_bases ADD CONSTRAINT accounting_tournament_fee_owner_bases_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES accounting_tournament_fee_owner_operations(operation_id);
DROP INDEX IF EXISTS public.idx_profiles_referral_code;
CREATE UNIQUE INDEX idx_profiles_referral_code ON public.profiles USING btree (referral_code) WHERE (referral_code IS NOT NULL);
CREATE UNIQUE INDEX poker_diamond_custody_occupancy ON public.poker_diamond_custody USING btree (occupancy_id) WHERE (occupancy_id IS NOT NULL);
CREATE INDEX poker_diamond_custody_seat ON public.poker_diamond_custody USING btree (seat_id) WHERE (seat_id IS NOT NULL);
CREATE UNIQUE INDEX table_seats_occupancy_id_unique ON public.table_seats USING btree (occupancy_id);
CREATE INDEX idx_tables_cluster_closed_status_drift ON public.tables USING btree (cluster_id) WHERE ((lifecycle = 'closed'::text) AND (status <> 'closed'::text));
CREATE INDEX idx_tables_cluster_open ON public.tables USING btree (cluster_id, role, main_index, created_at) WHERE (lifecycle <> 'closed'::text);
CREATE INDEX idx_tables_live_tournament_by_id ON public.tables USING btree (id) WHERE ((tournament_id IS NOT NULL) AND (status <> 'closed'::text));
CREATE INDEX idx_tournaments_updated_at ON public.tournaments USING btree (updated_at DESC);
CREATE INDEX idx_tournament_players_live_by_id ON public.tournament_players USING btree (id) WHERE (status = ANY (ARRAY['registered'::text, 'playing'::text]));
CREATE INDEX idx_poker_diamond_tournament_ledger_arena_id_fk ON public.poker_diamond_tournament_ledger USING btree (arena_id);
CREATE INDEX accounting_tournament_fee_recognitions_week ON public.accounting_tournament_fee_recognitions USING btree (recognized_at) INCLUDE (tournament_id);
CREATE INDEX accounting_tournament_fee_sources_club_event ON public.accounting_tournament_fee_sources USING btree (club_id, tournament_id);
CREATE INDEX accounting_tournament_fee_sources_coordinator_event ON public.accounting_tournament_fee_sources USING btree (coordinator_union_id, tournament_id) WHERE (coordinator_union_id IS NOT NULL);
CREATE INDEX accounting_tournament_fee_sources_event ON public.accounting_tournament_fee_sources USING btree (tournament_id, rake_record_id);
CREATE INDEX accounting_tournament_recognized_sources_event ON public.accounting_tournament_recognized_sources USING btree (tournament_id) INCLUDE (source_id, recognized_at, disposition, rake_credit);
CREATE INDEX accounting_tournament_recognized_sources_week ON public.accounting_tournament_recognized_sources USING btree (recognized_at, tournament_id);
CREATE INDEX cash_participant_funding_buyin_table ON public.cash_participant_funding_receipts USING btree (table_id, account_entity_id) WHERE (operation_kind = 'buyin'::text);
CREATE INDEX cash_participant_funding_occupancy ON public.cash_participant_funding_receipts USING btree (occupancy_id, recorded_at, id);
CREATE INDEX diamond_bonus_spin_tickets_by_user ON public.diamond_bonus_spin_tickets USING btree (user_id, created_at, id);
CREATE INDEX diamond_spin_days_open ON public.diamond_spin_days USING btree (day, owner_id) WHERE (status = 'open'::text);
CREATE INDEX lightning_instance_by_epoch ON public.lightning_instance USING btree (cluster_id, cluster_epoch);
CREATE INDEX lightning_instance_live_by_cluster ON public.lightning_instance USING btree (cluster_id, cluster_epoch) WHERE (state = ANY (ARRAY['forming'::text, 'reserved'::text, 'dealing'::text, 'settling'::text]));
CREATE INDEX lightning_instance_live_past_deadline ON public.lightning_instance USING btree (deadline_at) WHERE (state = ANY (ARRAY['forming'::text, 'reserved'::text, 'dealing'::text, 'settling'::text]));
CREATE UNIQUE INDEX lightning_instance_one_per_hand ON public.lightning_instance USING btree (hand_id) WHERE (hand_id IS NOT NULL);
CREATE INDEX lightning_pool_session_by_anchor_seat ON public.lightning_pool_session USING btree (anchor_seat_id);
CREATE INDEX lightning_pool_session_by_cash_session ON public.lightning_pool_session USING btree (cash_player_session_id);
CREATE INDEX lightning_pool_session_by_epoch ON public.lightning_pool_session USING btree (cluster_id, cluster_epoch);
CREATE UNIQUE INDEX lightning_pool_session_one_open ON public.lightning_pool_session USING btree (player_id, cluster_id) WHERE (exited_at IS NULL);
CREATE UNIQUE INDEX lightning_pool_session_one_open_per_anchor ON public.lightning_pool_session USING btree (anchor_seat_id) WHERE (exited_at IS NULL);
CREATE INDEX lightning_pool_session_open_by_cluster ON public.lightning_pool_session USING btree (cluster_id, cluster_epoch) WHERE (exited_at IS NULL);
CREATE INDEX lightning_pool_slot_by_session ON public.lightning_pool_slot USING btree (pool_session_id);
CREATE INDEX lightning_pool_slot_oldest_bb ON public.lightning_pool_slot USING btree (cluster_id, cluster_epoch, last_bb_at NULLS FIRST, player_id) WHERE (closed_at IS NULL);
CREATE UNIQUE INDEX lightning_pool_slot_one_open ON public.lightning_pool_slot USING btree (player_id, cluster_id, slot) WHERE (closed_at IS NULL);
CREATE UNIQUE INDEX lightning_pool_slot_one_open_per_player ON public.lightning_pool_slot USING btree (cluster_id, player_id) WHERE (closed_at IS NULL);
CREATE INDEX lightning_reservation_active_by_player ON public.lightning_reservation USING btree (player_id) WHERE (state = ANY (ARRAY['pending'::text, 'committed'::text]));
CREATE INDEX lightning_reservation_by_pool_slot ON public.lightning_reservation USING btree (pool_slot_id);
CREATE UNIQUE INDEX lightning_reservation_one_active_per_player ON public.lightning_reservation USING btree (cluster_id, player_id) WHERE (state = ANY (ARRAY['pending'::text, 'committed'::text]));
CREATE UNIQUE INDEX lightning_reservation_one_pending_per_slot ON public.lightning_reservation USING btree (pool_slot_id) WHERE (state = 'pending'::text);
CREATE UNIQUE INDEX lightning_reservation_one_seat_per_instance ON public.lightning_reservation USING btree (lightning_instance_id, seat_number) WHERE ((state = ANY (ARRAY['pending'::text, 'committed'::text])) AND (lightning_instance_id IS NOT NULL) AND (seat_number IS NOT NULL));
CREATE UNIQUE INDEX lightning_reservation_one_seat_per_player_instance ON public.lightning_reservation USING btree (player_id, lightning_instance_id) WHERE ((state = ANY (ARRAY['pending'::text, 'committed'::text])) AND (lightning_instance_id IS NOT NULL));
CREATE INDEX lightning_reservation_pending_by_expiry ON public.lightning_reservation USING btree (expires_at) WHERE (state = 'pending'::text);
CREATE UNIQUE INDEX cash_cluster_epoch_current ON public.cash_cluster_epoch USING btree (cluster_id) WHERE (ended_at IS NULL);
CREATE INDEX diamond_spin_movements_day ON public.diamond_spin_movements USING btree (owner_id, day, host_id);
CREATE INDEX lightning_hand_by_cluster_epoch ON public.lightning_hand USING btree (cluster_id, cluster_epoch, formed_at DESC);
CREATE INDEX lightning_hand_by_instance ON public.lightning_hand USING btree (lightning_instance_id);
CREATE UNIQUE INDEX lightning_hand_one_per_request ON public.lightning_hand USING btree (request_id);
CREATE INDEX lightning_hand_player_by_pool_slot ON public.lightning_hand_player USING btree (pool_slot_id);
CREATE UNIQUE INDEX lightning_hand_player_one_per_seat ON public.lightning_hand_player USING btree (hand_id, seat);
CREATE INDEX tournament_stages_due_idx ON public.tournament_stages USING btree (scheduled_start_utc) WHERE (state = 'scheduled'::text);
CREATE UNIQUE INDEX f06_one_active ON smarter_private.f06_attempts USING btree (break_id, user_id) WHERE (state = 'active'::text);
CREATE UNIQUE INDEX f06_one_winner ON smarter_private.f06_attempts USING btree (break_id, user_id) WHERE (state = 'winner'::text);
CREATE UNIQUE INDEX f06_one_hand ON smarter_private.f06_hand_permits USING btree (table_id) WHERE (state = 'reserved'::text);
CREATE UNIQUE INDEX f06_one_source ON smarter_private.f06_operations USING btree (source_table_id) WHERE (state <> ALL (ARRAY['acknowledged'::text, 'withdrawn_before_manifest'::text]));
CREATE UNIQUE INDEX f06_abort_retired_lease_generation ON smarter_private.f06_unsettled_hand_aborts USING btree (tournament_id, retired_lease_generation) WHERE (retired_lease_generation IS NOT NULL);
CREATE INDEX ix_tournament_obligations_user_created ON public.tournament_obligations USING btree (user_id, created_at DESC, id DESC) WHERE (user_id IS NOT NULL);
CREATE INDEX tournament_participant_fundin_tournament_id_registration_id_idx ON public.tournament_participant_funding_receipts USING btree (tournament_id, registration_id, observed_at);
CREATE INDEX tournament_participant_funding_receipts_registration ON public.tournament_participant_funding_receipts USING btree (registration_id);
CREATE INDEX union_pnl_inventory_events_players_observed ON public.union_pnl_inventory_events USING btree (observed_at) WHERE (source_name = 'tournament_players'::text);
CREATE INDEX union_pnl_inventory_transaction ON public.union_pnl_inventory_events USING btree (transaction_id, source_name);
CREATE INDEX tournament_accounting_credit_receipts_tournament ON public.tournament_accounting_credit_receipts USING btree (tournament_id);
CREATE INDEX tournament_obligation_events_obligation_id_event_id_idx ON public.tournament_obligation_events USING btree (obligation_id, event_id);
CREATE INDEX tournament_obligation_events_tournament_id_observed_at_even_idx ON public.tournament_obligation_events USING btree (tournament_id, observed_at, event_id);
CREATE INDEX union_pnl_inventory_touches_identity ON public.union_pnl_inventory_touches USING btree (source_name, row_id, event_id) INCLUDE (operation, union_id);
CREATE INDEX union_pnl_inventory_touches_week ON public.union_pnl_inventory_touches USING btree (source_name, observed_at);
CREATE INDEX union_pnl_credit_touches_week ON public.union_pnl_credit_touches USING btree (union_id, frame_observed_at);
DROP INDEX IF EXISTS public.idx_clubs_one_platform;
CREATE INDEX operational_alert_pending_idx ON public.operational_alert_events USING btree (investigation_status, id);
CREATE INDEX operational_notification_destinations_pending_idx ON public.operational_notification_destinations USING btree (captured_at, notification_id) WHERE (inbox_event_id IS NULL);
CREATE INDEX accounting_tournament_fee_owner_bases_operation ON public.accounting_tournament_fee_owner_bases USING btree (operation_id);
CREATE TRIGGER profile_account_changed AFTER UPDATE OF username, display_name, alias, first_name, last_name, full_name, display_name_preference, use_real_name, bio, player_tags, login_streak, vip_tier, settings, diamonds ON public.profiles FOR EACH ROW WHEN (((((((((((((((((old.username IS DISTINCT FROM new.username) OR (old.display_name IS DISTINCT FROM new.display_name)) OR (old.alias IS DISTINCT FROM new.alias)) OR (old.first_name IS DISTINCT FROM new.first_name)) OR (old.last_name IS DISTINCT FROM new.last_name)) OR (old.full_name IS DISTINCT FROM new.full_name)) OR (old.display_name_preference IS DISTINCT FROM new.display_name_preference)) OR (old.use_real_name IS DISTINCT FROM new.use_real_name)) OR (old.bio IS DISTINCT FROM new.bio)) OR (old.player_tags IS DISTINCT FROM new.player_tags)) OR (old.login_streak IS DISTINCT FROM new.login_streak)) OR (old.vip_tier IS DISTINCT FROM new.vip_tier)) OR ((old.settings -> 'theme'::text) IS DISTINCT FROM (new.settings -> 'theme'::text))) OR ((old.settings -> 'achievementNotifications'::text) IS DISTINCT FROM (new.settings -> 'achievementNotifications'::text))) OR ((old.settings -> 'settlementAlerts'::text) IS DISTINCT FROM (new.settings -> 'settlementAlerts'::text))) OR (old.diamonds IS DISTINCT FROM new.diamonds))) EXECUTE FUNCTION fn_publish_profile_account_change();
CREATE TRIGGER profile_appearance_changed AFTER UPDATE OF avatar_url, arena_avatar_url, use_avatar_as_profile_pic, is_vip, vip_expires_at, equipped_frame, equipped_aura ON public.profiles FOR EACH ROW WHEN ((((((((old.avatar_url IS DISTINCT FROM new.avatar_url) OR (old.arena_avatar_url IS DISTINCT FROM new.arena_avatar_url)) OR (old.use_avatar_as_profile_pic IS DISTINCT FROM new.use_avatar_as_profile_pic)) OR (old.is_vip IS DISTINCT FROM new.is_vip)) OR (old.vip_expires_at IS DISTINCT FROM new.vip_expires_at)) OR (old.equipped_frame IS DISTINCT FROM new.equipped_frame)) OR (old.equipped_aura IS DISTINCT FROM new.equipped_aura))) EXECUTE FUNCTION fn_publish_profile_appearance_change();
CREATE TRIGGER trg_a_closed_account_cannot_rewrite_itself BEFORE UPDATE ON public.profiles FOR EACH ROW WHEN ((old.status = 'deleted'::text)) EXECUTE FUNCTION fn_a_closed_account_cannot_rewrite_itself();
CREATE TRIGGER trg_only_close_account_closes_an_account BEFORE UPDATE ON public.profiles FOR EACH ROW WHEN (((new.status = 'deleted'::text) AND (old.status IS DISTINCT FROM 'deleted'::text))) EXECUTE FUNCTION fn_only_close_account_closes_an_account();
CREATE TRIGGER zz_diamond_spin_wallet_reserve BEFORE DELETE OR UPDATE OF diamonds ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_diamond_spin_wallet_reserve();
CREATE TRIGGER zzzz_guard_horse_profile_authority BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_guard_horse_profile_authority();
CREATE TRIGGER ab_ca_diamond_transfer_names_its_counterparty BEFORE INSERT ON public.diamond_transactions FOR EACH ROW EXECUTE FUNCTION fn_ca_diamond_transfer_names_its_counterparty();
CREATE TRIGGER wallet_transfers_append_only BEFORE DELETE OR UPDATE ON public.diamond_wallet_transfers FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only();
CREATE CONSTRAINT TRIGGER zzz_diamond_entry_custody_is_the_entry AFTER INSERT OR UPDATE ON public.poker_diamond_custody DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_entry_custody_is_the_entry();
DROP TRIGGER IF EXISTS trg_stamp_seat_horse_id ON public.table_seats;
DROP TRIGGER IF EXISTS zy_tournament_live_seat_exit_requires_authority ON public.table_seats;
CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
CREATE TRIGGER poker_bind_diamond_seat AFTER INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_poker_bind_diamond_seat();
CREATE TRIGGER trg_stamp_seat_horse_id BEFORE INSERT OR UPDATE OF user_id, horse_id ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_horse_id();
CREATE TRIGGER trg_table_seats_lightning_anchor_delete_guard BEFORE DELETE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_table_seats_lightning_anchor_guard();
CREATE TRIGGER trg_table_seats_lightning_anchor_guard BEFORE UPDATE ON public.table_seats FOR EACH ROW WHEN (((old.stack IS DISTINCT FROM new.stack) OR (old.left_at IS DISTINCT FROM new.left_at) OR (old.user_id IS DISTINCT FROM new.user_id))) EXECUTE FUNCTION fn_table_seats_lightning_anchor_guard();
CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_follows_seat AFTER UPDATE ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.left_at IS DISTINCT FROM new.left_at) OR (old.user_id IS DISTINCT FROM new.user_id) OR (old.is_sitting_out IS DISTINCT FROM new.is_sitting_out) OR (old.leave_pending IS DISTINCT FROM new.leave_pending) OR ((COALESCE(old.stack, (0)::numeric) > (0)::numeric) IS DISTINCT FROM (COALESCE(new.stack, (0)::numeric) > (0)::numeric)))) EXECUTE FUNCTION fn_table_seats_lightning_pool_follows_seat();
CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_on_insert AFTER INSERT ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.left_at IS NULL) AND (new.user_id IS NOT NULL) AND (COALESCE(new.stack, (0)::numeric) > (0)::numeric) AND (COALESCE(new.is_sitting_out, false) = false) AND (COALESCE(new.leave_pending, false) = false))) EXECUTE FUNCTION fn_table_seats_lightning_pool_follows_seat();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.table_seats FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE CONSTRAINT TRIGGER zz_close_session_when_seat_vacated AFTER UPDATE OF left_at ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_fn_close_session_when_seat_vacated();
CREATE CONSTRAINT TRIGGER zzz_diamond_seat_keeps_custody AFTER INSERT OR DELETE OR UPDATE ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_seat_keeps_custody();
CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy();
CREATE TRIGGER zzzz_stamp_active_seat_game_scope BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_active_seat_game_scope();
CREATE TRIGGER zzzzz_require_live_seat_parent BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_require_live_seat_parent();
CREATE TRIGGER zzzzz_seat_parent_keys_match BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION trg_seat_parent_keys_match();
CREATE CONSTRAINT TRIGGER zzzzzz_tournament_felt_may_not_exceed_supply AFTER INSERT OR UPDATE OF stack, left_at ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_tournament_felt_may_not_exceed_supply();
CREATE TRIGGER a00_f06_lifecycle BEFORE INSERT OR DELETE OR UPDATE OF id, tournament_id, status, lifecycle, is_deleted, f06_lifecycle ON public.tables FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_table_guard();
CREATE TRIGGER tournament_table_inherits_committed_blinds BEFORE INSERT ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_tournament_table_inherits_committed_blinds();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tables FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER zz_cancel_cash_seat_moves_on_table_close AFTER UPDATE OF status, seat_admission_key ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_cancel_cash_seat_moves_on_table_close();
CREATE TRIGGER zz_close_sessions_when_table_closes AFTER UPDATE OF status, is_deleted ON public.tables FOR EACH ROW EXECUTE FUNCTION trg_fn_close_sessions_when_table_closes();
CREATE TRIGGER zz_tables_kill_pot_guard BEFORE INSERT OR UPDATE OF kill_mode, kill_threshold_bb, game_variant, game_type, tournament_id, bomb_pot_enabled, big_blind, club_id ON public.tables FOR EACH ROW WHEN ((new.kill_mode IS DISTINCT FROM 'off'::text)) EXECUTE FUNCTION fn_tables_kill_pot_guard();
CREATE TRIGGER zzzz_stamp_table_game_scope BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_stamp_table_game_scope();
CREATE TRIGGER zzzz_stamp_table_seat_admission BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_stamp_table_seat_admission();
CREATE TRIGGER zzzzz_table_parent_keys_guard BEFORE UPDATE ON public.tables FOR EACH ROW WHEN ((old.seat_admission_key IS DISTINCT FROM new.seat_admission_key)) EXECUTE FUNCTION trg_table_parent_keys_guard();
CREATE TRIGGER zzzzz_table_scope_cascade AFTER UPDATE ON public.tables FOR EACH ROW WHEN ((old.seat_game_scope IS DISTINCT FROM new.seat_game_scope)) EXECUTE FUNCTION trg_table_scope_cascade();
CREATE TRIGGER zzzzzz_tables_stakes_follows_its_own_blinds BEFORE UPDATE OF small_blind, big_blind, stakes ON public.tables FOR EACH ROW WHEN (((new.tournament_id IS NOT NULL) AND ((old.small_blind IS DISTINCT FROM new.small_blind) OR (old.big_blind IS DISTINCT FROM new.big_blind) OR (old.stakes IS DISTINCT FROM new.stakes)))) EXECUTE FUNCTION fn_tables_stakes_follows_its_own_blinds();
DROP TRIGGER IF EXISTS aa_guard_tournament_completing_claim ON public.tournaments;
DROP TRIGGER IF EXISTS aaa_guard_atomic_satellite_completion ON public.tournaments;
DROP TRIGGER IF EXISTS zzzz_freeze_finalized_tournament_prize_pool ON public.tournaments;
DROP TRIGGER IF EXISTS zzzz_tournament_pool_finalization_window_guard ON public.tournaments;
DROP TRIGGER IF EXISTS zzzz_tournaments_atomic_place_completion_guard ON public.tournaments;
DROP TRIGGER IF EXISTS zzzzz_tournaments_atomic_final_table_deal_completion_guard ON public.tournaments;
DROP TRIGGER IF EXISTS zzzzzz_tournaments_financial_certificate ON public.tournaments;
CREATE TRIGGER aa_guard_tournament_completing_claim BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_completing_claim();
ALTER TABLE public.tournaments DISABLE TRIGGER aa_guard_tournament_completing_claim;
CREATE TRIGGER aaa_guard_atomic_satellite_completion BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_guard_atomic_satellite_completion();
ALTER TABLE public.tournaments DISABLE TRIGGER aaa_guard_atomic_satellite_completion;
CREATE TRIGGER trg_clear_seats_on_game_end AFTER UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_clear_seats_on_game_end();
CREATE TRIGGER trg_release_seats_on_tournament_finish AFTER UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_release_seats_on_tournament_finish();
CREATE TRIGGER trg_tournaments_record_conclusion AFTER UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = ANY (ARRAY['COMPLETED'::text, 'CANCELLED'::text])) AND (new.status IS DISTINCT FROM old.status))) EXECUTE FUNCTION fn_tournament_record_conclusion();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tournaments FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER zzzz_freeze_finalized_tournament_prize_pool BEFORE UPDATE OF prize_pool, guaranteed_prize, prize_pool_finalized, payout_structure, spin_multiplier ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_freeze_finalized_tournament_prize_pool();
ALTER TABLE public.tournaments DISABLE TRIGGER zzzz_freeze_finalized_tournament_prize_pool;
CREATE TRIGGER zzzz_tournament_pool_finalization_window_guard BEFORE UPDATE OF prize_pool_finalized ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_tournament_pool_finalization_window_guard();
ALTER TABLE public.tournaments DISABLE TRIGGER zzzz_tournament_pool_finalization_window_guard;
CREATE TRIGGER zzzz_tournaments_atomic_place_completion_guard BEFORE UPDATE ON public.tournaments FOR EACH ROW WHEN (((new.status = 'COMPLETED'::text) AND (old.status IS DISTINCT FROM 'COMPLETED'::text))) EXECUTE FUNCTION trg_tournament_atomic_place_completion_guard();
ALTER TABLE public.tournaments DISABLE TRIGGER zzzz_tournaments_atomic_place_completion_guard;
CREATE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = 'COMPLETED'::text) AND (old.status IS DISTINCT FROM 'COMPLETED'::text))) EXECUTE FUNCTION trg_atomic_final_table_deal_completion_guard();
ALTER TABLE public.tournaments DISABLE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard;
CREATE TRIGGER zzzzzz_tournaments_financial_certificate BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = 'COMPLETED'::text) AND (old.status IS DISTINCT FROM 'COMPLETED'::text))) EXECUTE FUNCTION fn_guard_tournament_completed_certificate();
ALTER TABLE public.tournaments DISABLE TRIGGER zzzzzz_tournaments_financial_certificate;
CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
CREATE CONSTRAINT TRIGGER a_player_is_not_eliminated_from_a_game_that_never_started AFTER INSERT OR UPDATE ON public.tournament_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.status = ANY (ARRAY['eliminated'::text, 'winner'::text]))) EXECUTE FUNCTION fn_player_needs_a_started_game();
CREATE CONSTRAINT TRIGGER tournament_elimination_has_a_place AFTER INSERT OR UPDATE OF status, "position" ON public.tournament_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_tournament_elimination_has_a_place();
CREATE TRIGGER trg_tournament_players_bagged_custody_fence BEFORE INSERT OR DELETE OR UPDATE OF chips, status, current_bounty, tournament_id ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_tournament_players_bagged_custody_fence();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tournament_players FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER mixed_cutover_spin_proof_immutable BEFORE DELETE OR UPDATE ON public.accounting_mixed_cutover_spin_fee_proofs FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER mixed_cutover_spin_proof_no_truncate BEFORE TRUNCATE ON public.accounting_mixed_cutover_spin_fee_proofs FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_batches_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_batches FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_batches_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_batches FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER legacy_fee_custody_is_append_only BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_custody_obligations FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_fee_custody_is_append_only();
CREATE TRIGGER legacy_fee_custody_refuses_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_custody_obligations FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_legacy_fee_custody_is_append_only();
CREATE CONSTRAINT TRIGGER legacy_fee_custody_requires_terminal AFTER INSERT ON public.accounting_tournament_fee_custody_obligations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_fee_custody_requires_terminal();
CREATE TRIGGER legacy_fee_resolution_is_append_only BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_custody_resolutions FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_fee_custody_is_append_only();
CREATE TRIGGER legacy_fee_resolution_refuses_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_custody_resolutions FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_legacy_fee_custody_is_append_only();
CREATE CONSTRAINT TRIGGER legacy_fee_resolution_requires_recognition AFTER INSERT ON public.accounting_tournament_fee_custody_resolutions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_fee_resolution_requires_recognition();
CREATE TRIGGER accounting_tournament_fee_cutover_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_cutover FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_cutover FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER ca_fee_cutover_is_drained BEFORE INSERT ON public.accounting_tournament_fee_cutover FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_fee_cutover_is_drained();
CREATE TRIGGER accounting_tournament_fee_recognitions_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_recognitions FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_recognitions_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_recognitions FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id, tournament_id ON public.accounting_tournament_fee_sources FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_chip_money();
CREATE TRIGGER accounting_tournament_fee_sources_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_recognized_sources_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_recognized_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_recognized_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_recognized_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER cash_funding_immutable BEFORE DELETE OR UPDATE ON public.cash_participant_funding_receipts FOR EACH ROW EXECUTE FUNCTION fn_cash_provenance_immutable();
CREATE TRIGGER cash_participant_funding_receipts_no_truncate BEFORE TRUNCATE ON public.cash_participant_funding_receipts FOR EACH STATEMENT EXECUTE FUNCTION fn_cash_provenance_immutable();
CREATE TRIGGER original_union_pnl_frame BEFORE INSERT ON public.cash_participant_funding_receipts FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_receipt_frame();
CREATE CONSTRAINT TRIGGER diamond_bonus_spin_settled AFTER UPDATE ON public.diamond_bonus_spin_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_diamond_bonus_spin_settled();
CREATE TRIGGER diamond_bonus_spin_ticket_guard BEFORE INSERT OR DELETE OR UPDATE ON public.diamond_bonus_spin_tickets FOR EACH ROW EXECUTE FUNCTION fn_diamond_bonus_spin_ticket_guard();
CREATE TRIGGER diamond_spin_days_immutable BEFORE DELETE OR UPDATE ON public.diamond_spin_days FOR EACH ROW EXECUTE FUNCTION fn_diamond_spin_immutable();
CREATE CONSTRAINT TRIGGER diamond_spin_settlement_receipt AFTER INSERT OR UPDATE ON public.diamond_spin_days DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_diamond_spin_settlement_receipt();
CREATE TRIGGER trg_lightning_instance_is_disciplined BEFORE INSERT OR UPDATE ON public.lightning_instance FOR EACH ROW EXECUTE FUNCTION fn_lightning_instance_is_disciplined();
CREATE TRIGGER trg_lightning_instance_refuses_truncate BEFORE TRUNCATE ON public.lightning_instance FOR EACH STATEMENT EXECUTE FUNCTION fn_lightning_refuses_truncate();
CREATE TRIGGER trg_lightning_instance_releases_its_reservations AFTER UPDATE ON public.lightning_instance FOR EACH ROW WHEN (((new.state = ANY (ARRAY['complete'::text, 'abandoned'::text])) AND (old.state IS DISTINCT FROM new.state))) EXECUTE FUNCTION fn_lightning_instance_releases_its_reservations();
CREATE TRIGGER trg_lightning_pool_session_refuses_truncate BEFORE TRUNCATE ON public.lightning_pool_session FOR EACH STATEMENT EXECUTE FUNCTION fn_lightning_refuses_truncate();
CREATE TRIGGER trg_lightning_pool_slot_holds_its_history BEFORE DELETE ON public.lightning_pool_slot FOR EACH ROW EXECUTE FUNCTION fn_lightning_pool_slot_holds_its_history();
CREATE TRIGGER trg_lightning_pool_slot_refuses_truncate BEFORE TRUNCATE ON public.lightning_pool_slot FOR EACH STATEMENT EXECUTE FUNCTION fn_lightning_refuses_truncate();
CREATE TRIGGER trg_matcher_slot_idle_since_starts_at_open BEFORE INSERT ON public.lightning_pool_slot FOR EACH ROW EXECUTE FUNCTION fn_lightning_pool_slot_idle_since_starts_at_open();
CREATE TRIGGER trg_lightning_reservation_is_disciplined BEFORE INSERT OR UPDATE ON public.lightning_reservation FOR EACH ROW EXECUTE FUNCTION fn_lightning_reservation_is_disciplined();
CREATE TRIGGER trg_lightning_reservation_refuses_truncate BEFORE TRUNCATE ON public.lightning_reservation FOR EACH STATEMENT EXECUTE FUNCTION fn_lightning_refuses_truncate();
CREATE TRIGGER trg_matcher_reservation_end_marks_the_slot_idle AFTER UPDATE OF state ON public.lightning_reservation FOR EACH ROW WHEN (((old.state = ANY (ARRAY['pending'::text, 'committed'::text])) AND (new.state = ANY (ARRAY['released'::text, 'expired'::text])))) EXECUTE FUNCTION fn_lightning_reservation_end_marks_the_slot_idle();
CREATE CONSTRAINT TRIGGER original_paid_custody_completed AFTER INSERT OR UPDATE ON public.tournament_paid_stack_custody_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_original_paid_stack_must_complete();
CREATE TRIGGER original_paid_custody_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_paid_stack_custody_receipts FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_original_paid_stack_receipt();
CREATE TRIGGER original_paid_custody_no_truncate BEFORE TRUNCATE ON public.tournament_paid_stack_custody_receipts FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_original_paid_stack_receipt();
CREATE TRIGGER tournament_stage_resume_receipts_no_truncate BEFORE TRUNCATE ON public.tournament_stage_resume_receipts FOR EACH STATEMENT EXECUTE FUNCTION fn_multi_day_stage_rows_never_truncate();
CREATE TRIGGER tournament_stage_resume_receipts_rpc_owned BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_stage_resume_receipts FOR EACH ROW EXECUTE FUNCTION fn_multi_day_stage_rows_are_rpc_owned();
CREATE TRIGGER diamond_spin_movements_immutable BEFORE DELETE OR UPDATE ON public.diamond_spin_movements FOR EACH ROW EXECUTE FUNCTION fn_diamond_spin_immutable();
CREATE TRIGGER trg_lightning_hand_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.lightning_hand FOR EACH ROW EXECUTE FUNCTION fn_lightning_hand_is_immutable();
CREATE TRIGGER trg_lightning_hand_refuses_truncate BEFORE TRUNCATE ON public.lightning_hand FOR EACH STATEMENT EXECUTE FUNCTION fn_lightning_refuses_truncate();
CREATE TRIGGER trg_lightning_hand_player_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.lightning_hand_player FOR EACH ROW EXECUTE FUNCTION fn_lightning_hand_player_is_immutable();
CREATE TRIGGER trg_lightning_hand_player_refuses_truncate BEFORE TRUNCATE ON public.lightning_hand_player FOR EACH STATEMENT EXECUTE FUNCTION fn_lightning_refuses_truncate();
CREATE TRIGGER tournament_stages_no_truncate BEFORE TRUNCATE ON public.tournament_stages FOR EACH STATEMENT EXECUTE FUNCTION fn_multi_day_stage_rows_never_truncate();
CREATE TRIGGER tournament_stages_rpc_owned BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_stages FOR EACH ROW EXECUTE FUNCTION fn_multi_day_stage_rows_are_rpc_owned();
CREATE TRIGGER tournament_stage_plans_no_truncate BEFORE TRUNCATE ON public.tournament_stage_plans FOR EACH STATEMENT EXECUTE FUNCTION fn_multi_day_stage_rows_never_truncate();
CREATE TRIGGER tournament_stage_plans_rpc_owned BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_stage_plans FOR EACH ROW EXECUTE FUNCTION fn_multi_day_stage_rows_are_rpc_owned();
CREATE TRIGGER breakfast_witness_immutable BEFORE DELETE OR UPDATE ON smarter_private.breakfast_original_witness FOR EACH ROW EXECUTE FUNCTION smarter_private.breakfast_witness_immutable();
CREATE TRIGGER breakfast_witness_no_truncate BEFORE TRUNCATE ON smarter_private.breakfast_original_witness FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.breakfast_witness_immutable();
CREATE TRIGGER f06_attempts_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_attempts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity();
CREATE TRIGGER f06_movement_dispatch BEFORE INSERT OR UPDATE ON smarter_private.f06_dispatch FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_movement_transition_guard();
CREATE TRIGGER f06_hand_permits_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity();
CREATE TRIGGER f06_mixed_preparation_custody BEFORE INSERT OR UPDATE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_mixed_preparation_guard();
CREATE TRIGGER f06_retained_submission_guard AFTER UPDATE OF state ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_retained_submission_guard();
CREATE TRIGGER f06_members_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_members FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity();
CREATE TRIGGER f06_movement_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_movement_admissions FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_movement_immutable();
CREATE TRIGGER f06_movement_no_truncate BEFORE TRUNCATE ON smarter_private.f06_movement_admissions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_movement_immutable();
CREATE TRIGGER f06_movement_manifest BEFORE UPDATE OF manifest ON smarter_private.f06_operations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_movement_transition_guard();
CREATE TRIGGER f06_operations_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_operations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity();
CREATE TRIGGER spin_archived_first_immutable BEFORE DELETE OR UPDATE ON smarter_private.spin_archived_first_admission FOR EACH ROW EXECUTE FUNCTION smarter_private.spin_archived_first_immutable();
CREATE TRIGGER spin_archived_first_no_truncate BEFORE TRUNCATE ON smarter_private.spin_archived_first_admission FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.spin_archived_first_immutable();
CREATE CONSTRAINT TRIGGER spin_archived_first_requires_terminal AFTER INSERT ON smarter_private.spin_archived_first_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION smarter_private.spin_archived_first_requires_terminal();
CREATE TRIGGER spin_original_standings_immutable BEFORE DELETE OR UPDATE ON smarter_private.spin_original_standings FOR EACH ROW EXECUTE FUNCTION smarter_private.spin_original_standings_immutable();
CREATE TRIGGER spin_original_standings_no_truncate BEFORE TRUNCATE ON smarter_private.spin_original_standings FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.spin_original_standings_immutable();
CREATE CONSTRAINT TRIGGER spin_original_standings_requires_terminal AFTER INSERT ON smarter_private.spin_original_standings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION smarter_private.spin_original_standings_requires_terminal();
CREATE TRIGGER f06_generation_child_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_generation_abort_hands FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_manager_custody_admissions FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON smarter_private.f06_manager_custody_admissions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();
CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_manager_custody_completions FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON smarter_private.f06_manager_custody_completions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();
CREATE TRIGGER f06_manager_transfer_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_manager_custody_transfers FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();
CREATE TRIGGER f06_manager_transfer_no_truncate BEFORE TRUNCATE ON smarter_private.f06_manager_custody_transfers FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();
CREATE TRIGGER f06_mixed_hands_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_mixed_abort_hands FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER f06_no_start_continuation_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_no_start_continuations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_no_start_continuation_immutable();
CREATE TRIGGER f06_no_start_continuation_no_truncate BEFORE TRUNCATE ON smarter_private.f06_no_start_continuations FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_no_start_continuation_immutable();
CREATE TRIGGER f06_abort_receipt_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_unsettled_hand_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER hand_submission_disposition_immutable BEFORE DELETE OR UPDATE ON smarter_private.hand_submission_dispositions FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_disposition_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_dispositions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER f06_generation_receipt_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_generation_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER f06_mixed_generations_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_mixed_abort_generations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER f06_mixed_receipt_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_mixed_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
CREATE TRIGGER trg_cash_games_epoch_follows_its_game AFTER INSERT OR UPDATE OF cluster_epoch, cluster_mode ON public.cash_games FOR EACH ROW EXECUTE FUNCTION fn_cash_cluster_epoch_follows_its_game();
CREATE TRIGGER zz_tournament_accounting_obligation_event AFTER INSERT OR DELETE OR UPDATE ON public.tournament_obligations FOR EACH ROW EXECUTE FUNCTION fn_ca_capture_tournament_obligation_event();
CREATE TRIGGER original_evidence_immutable BEFORE DELETE OR UPDATE ON public.tournament_participant_funding_receipts FOR EACH ROW EXECUTE FUNCTION fn_ca_tournament_accounting_evidence_immutable();
CREATE TRIGGER original_evidence_no_truncate BEFORE TRUNCATE ON public.tournament_participant_funding_receipts FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_tournament_accounting_evidence_immutable();
CREATE TRIGGER original_union_pnl_frame BEFORE INSERT ON public.tournament_participant_funding_receipts FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_receipt_frame();
CREATE TRIGGER original_pnl_inventory_events_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_inventory_events FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();
CREATE TRIGGER union_pnl_inventory_touch AFTER INSERT ON public.union_pnl_inventory_events FOR EACH ROW WHEN ((new.source_name = ANY (ARRAY['tournament_players'::text, 'tournaments'::text]))) EXECUTE FUNCTION fn_union_pnl_inventory_touch();
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_transaction_frames FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_evidence_immutable BEFORE DELETE OR UPDATE ON public.tournament_accounting_credit_receipts FOR EACH ROW EXECUTE FUNCTION fn_ca_tournament_accounting_evidence_immutable();
CREATE TRIGGER original_evidence_no_truncate BEFORE TRUNCATE ON public.tournament_accounting_credit_receipts FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_tournament_accounting_evidence_immutable();
CREATE TRIGGER original_union_pnl_frame BEFORE INSERT ON public.tournament_accounting_credit_receipts FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_receipt_frame();
CREATE TRIGGER union_pnl_credit_touch AFTER INSERT ON public.tournament_accounting_credit_receipts FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_credit_touch();
CREATE TRIGGER original_evidence_immutable BEFORE DELETE OR UPDATE ON public.tournament_obligation_events FOR EACH ROW EXECUTE FUNCTION fn_ca_tournament_accounting_evidence_immutable();
CREATE TRIGGER original_evidence_no_truncate BEFORE TRUNCATE ON public.tournament_obligation_events FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_tournament_accounting_evidence_immutable();
CREATE TRIGGER original_union_pnl_frame BEFORE INSERT ON public.tournament_obligation_events FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_receipt_frame();
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_inventory_touches FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_credit_touches FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();
CREATE TRIGGER diamond_game_club_reserves BEFORE UPDATE OF promo_balance, chip_treasury ON public.clubs FOR EACH ROW EXECUTE FUNCTION fn_diamond_game_reserved_cover_guard();
CREATE TRIGGER trg_seed_all_throwables_shop_item AFTER INSERT ON public.clubs FOR EACH ROW EXECUTE FUNCTION fn_seed_all_throwables_shop_item();
DROP TRIGGER IF EXISTS trg_mirror_notification_to_push_outbox ON public.notifications;
CREATE CONSTRAINT TRIGGER trg_accounting_push_after_delivery AFTER INSERT ON public.notifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.type = 'accounting_invoice'::text)) EXECUTE FUNCTION fn_mirror_notification_to_push_outbox();
CREATE TRIGGER trg_mirror_notification_to_push_outbox AFTER INSERT ON public.notifications FOR EACH ROW WHEN ((NOT fn_is_owner_operational_notification(new.user_id, new.type, new.title, new.data))) EXECUTE FUNCTION fn_mirror_notification_to_push_outbox();
CREATE TRIGGER zz_capture_owner_notification_destination BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION fn_capture_owner_notification_destination();
CREATE TRIGGER owner_fee_basis_is_append_only BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_owner_bases FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_owner_basis_is_append_only();
CREATE TRIGGER owner_fee_basis_refuses_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_owner_bases FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_owner_basis_is_append_only();
CREATE TRIGGER owner_fee_operation_is_append_only BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_owner_operations FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_owner_basis_is_append_only();
CREATE TRIGGER owner_fee_operation_refuses_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_owner_operations FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_owner_basis_is_append_only();

-- Production's grants to anon, authenticated and service_role on every relation this fixture
-- holds (public and smarter_private), read read-only from pg_class.relacl. The historical
-- base carries none, and code that runs as the session role - a deferred trigger firing at
-- COMMIT, above all - reads with these grants in production.
ALTER ROLE service_role BYPASSRLS;
GRANT SELECT ON SEQUENCE global_hand_number_seq TO anon;
GRANT SELECT ON SEQUENCE global_hand_number_seq TO authenticated;
GRANT SELECT ON SEQUENCE global_hand_number_seq TO service_role;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE ad_event_id_seq, article_bookmarks_id_seq, bbj_hand_evidence_log_id_seq, bomb_pot_award_units_id_seq, bomb_pot_manual_requests_id_seq, bot_number_seq, ca_account_snapshots_id_seq, ca_alarm_drills_id_seq, ca_bbj_bucket_moves_id_seq, ca_bbj_pool_snapshots_id_seq, ca_bridge_rate_history_id_seq, ca_collusion_signals_id_seq, ca_currency_meter_id_seq, ca_daily_bonus_calendar_history_id_seq, ca_daily_bonus_calendar_id_seq, ca_ddl_events_id_seq, ca_diamond_balance_audit_id_seq, ca_diamond_house_ledger_id_seq, ca_diamond_incidents_id_seq, ca_diamond_snapshots_id_seq, ca_escrow_shadow_runs_id_seq, ca_financial_epochs_id_seq, ca_freeroll_free_buy_log_id_seq, ca_frozen_pool_baseline_changes_id_seq, ca_frozen_pool_deletions_id_seq, ca_gate_runs_id_seq, ca_guard_def_history_id_seq, ca_guard_inventory_id_seq, ca_horse_fleet_heartbeat_id_seq, ca_incident_events_id_seq, ca_ledger_day_manifest_restatements_id_seq, ca_ledger_mutation_log_id_seq, ca_ledger_write_failures_id_seq, ca_mint_policy_changes_id_seq, ca_pgrst_reload_log_id_seq, ca_profile_deletions_id_seq, ca_restriction_observations_id_seq, ca_seat_stack_exits_id_seq, ca_seat_stack_rebases_id_seq, ca_stats_witness_audit_log_id_seq, ca_supply_snapshots_id_seq, cash_cluster_events_id_seq, charity_events_schedule_id_seq, chip_ledger_chain_seq, clawbot_audit_log_id_seq, client_shell_telemetry_id_seq, club_entry_events_id_seq, club_profit_reconcile_log_id_seq, commander_home_group_share_log_id_seq, commander_home_group_view_log_id_seq, commander_home_join_attempts_id_seq, content_asset_use_id_seq, content_authors_id_seq, customization_operations_id_seq, daily_challenge_catalog_history_id_seq, db_saturation_selftest_log_id_seq, deep_stack_delete_attempts_id_seq, diamond_game_config_history_id_seq, diamond_reward_catalog_history_id_seq, employee_number_seq, engine_alerts_id_seq, game_live_history_id_seq, game_management_events_sequence_seq, geeves_missed_questions_id_seq, hand_id_seq, horse_hand_reviews_id_seq, horse_league_results_id_seq, horse_phrase_ledger_id_seq, horse_self_tune_log_id_seq, horse_thread_state_id_seq, leaderboard_payout_failures_id_seq, notification_prompt_log_id_seq, page_followers_id_seq, personas_id_seq, pgrst_reload_watchdog_log_id_seq, phase22_rls_table_audit_id_seq, phase22_secdef_grant_audit_id_seq, phase22_view_security_audit_id_seq, player_number_seq, poker_diamond_tournament_ledger_id_seq, poker_series_id_seq, poker_tour_series_events_id_seq, poker_venues_id_seq, probe_heartbeats_id_seq, profiles_player_number_seq, public_player_number_seq, qr_code_scans_id_seq, scrape_source_registry_id_seq, scraper_metrics_id_seq, signup_errors_archive_id_seq, signup_errors_id_seq, stable_hand_beats_id_seq, table_settings_changes_id_seq, tour_event_details_id_seq, tour_events_id_seq, tour_schedule_registry_id_seq, tour_schedule_sources_id_seq, tournament_schedule_spawns_id_seq, tournament_series_id_seq, trivia_diamond_award_limits_history_id_seq, venue_game_schedules_id_seq, venue_live_history_id_seq, venue_live_tables_id_seq, venue_news_id_seq, wheel_config_history_id_seq TO anon;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE ad_event_id_seq, article_bookmarks_id_seq, bbj_hand_evidence_log_id_seq, bomb_pot_award_units_id_seq, bomb_pot_manual_requests_id_seq, bot_number_seq, ca_account_snapshots_id_seq, ca_alarm_drills_id_seq, ca_bbj_bucket_moves_id_seq, ca_bbj_pool_snapshots_id_seq, ca_bridge_rate_history_id_seq, ca_collusion_signals_id_seq, ca_currency_meter_id_seq, ca_daily_bonus_calendar_history_id_seq, ca_daily_bonus_calendar_id_seq, ca_ddl_events_id_seq, ca_diamond_balance_audit_id_seq, ca_diamond_house_ledger_id_seq, ca_diamond_incidents_id_seq, ca_diamond_snapshots_id_seq, ca_escrow_shadow_runs_id_seq, ca_financial_epochs_id_seq, ca_freeroll_free_buy_log_id_seq, ca_frozen_pool_baseline_changes_id_seq, ca_frozen_pool_deletions_id_seq, ca_gate_runs_id_seq, ca_guard_def_history_id_seq, ca_guard_inventory_id_seq, ca_horse_fleet_heartbeat_id_seq, ca_incident_events_id_seq, ca_ledger_day_manifest_restatements_id_seq, ca_ledger_mutation_log_id_seq, ca_ledger_write_failures_id_seq, ca_mint_policy_changes_id_seq, ca_pgrst_reload_log_id_seq, ca_profile_deletions_id_seq, ca_restriction_observations_id_seq, ca_seat_stack_exits_id_seq, ca_seat_stack_rebases_id_seq, ca_stats_witness_audit_log_id_seq, ca_supply_snapshots_id_seq, cash_cluster_events_id_seq, charity_events_schedule_id_seq, chip_ledger_chain_seq, clawbot_audit_log_id_seq, client_shell_telemetry_id_seq, club_entry_events_id_seq, club_profit_reconcile_log_id_seq, commander_home_group_share_log_id_seq, commander_home_group_view_log_id_seq, commander_home_join_attempts_id_seq, content_asset_use_id_seq, content_authors_id_seq, customization_operations_id_seq, daily_challenge_catalog_history_id_seq, db_saturation_selftest_log_id_seq, deep_stack_delete_attempts_id_seq, diamond_game_config_history_id_seq, diamond_reward_catalog_history_id_seq, employee_number_seq, engine_alerts_id_seq, game_live_history_id_seq, game_management_events_sequence_seq, geeves_missed_questions_id_seq, hand_id_seq, horse_hand_reviews_id_seq, horse_league_results_id_seq, horse_phrase_ledger_id_seq, horse_self_tune_log_id_seq, horse_thread_state_id_seq, leaderboard_payout_failures_id_seq, notification_prompt_log_id_seq, page_followers_id_seq, personas_id_seq, pgrst_reload_watchdog_log_id_seq, phase22_rls_table_audit_id_seq, phase22_secdef_grant_audit_id_seq, phase22_view_security_audit_id_seq, player_number_seq, poker_diamond_tournament_ledger_id_seq, poker_series_id_seq, poker_tour_series_events_id_seq, poker_venues_id_seq, probe_heartbeats_id_seq, profiles_player_number_seq, public_player_number_seq, qr_code_scans_id_seq, scrape_source_registry_id_seq, scraper_metrics_id_seq, signup_errors_archive_id_seq, signup_errors_id_seq, stable_hand_beats_id_seq, table_settings_changes_id_seq, tour_event_details_id_seq, tour_events_id_seq, tour_schedule_registry_id_seq, tour_schedule_sources_id_seq, tournament_schedule_spawns_id_seq, tournament_series_id_seq, trivia_diamond_award_limits_history_id_seq, venue_game_schedules_id_seq, venue_live_history_id_seq, venue_live_tables_id_seq, venue_news_id_seq, wheel_config_history_id_seq TO authenticated;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE ad_event_id_seq, article_bookmarks_id_seq, bbj_hand_evidence_log_id_seq, bomb_pot_award_units_id_seq, bomb_pot_manual_requests_id_seq, bot_number_seq, ca_account_snapshots_id_seq, ca_alarm_drills_id_seq, ca_bbj_bucket_moves_id_seq, ca_bbj_pool_snapshots_id_seq, ca_bridge_rate_history_id_seq, ca_collusion_signals_id_seq, ca_currency_meter_id_seq, ca_daily_bonus_calendar_history_id_seq, ca_daily_bonus_calendar_id_seq, ca_ddl_events_id_seq, ca_diamond_balance_audit_id_seq, ca_diamond_house_ledger_id_seq, ca_diamond_incidents_id_seq, ca_diamond_snapshots_id_seq, ca_escrow_shadow_runs_id_seq, ca_financial_epochs_id_seq, ca_freeroll_free_buy_log_id_seq, ca_frozen_pool_baseline_changes_id_seq, ca_frozen_pool_deletions_id_seq, ca_gate_runs_id_seq, ca_guard_def_history_id_seq, ca_guard_inventory_id_seq, ca_horse_fleet_heartbeat_id_seq, ca_incident_events_id_seq, ca_ledger_day_manifest_restatements_id_seq, ca_ledger_mutation_log_id_seq, ca_ledger_write_failures_id_seq, ca_mint_policy_changes_id_seq, ca_pgrst_reload_log_id_seq, ca_profile_deletions_id_seq, ca_restriction_observations_id_seq, ca_seat_stack_exits_id_seq, ca_seat_stack_rebases_id_seq, ca_stats_witness_audit_log_id_seq, ca_supply_snapshots_id_seq, cash_cluster_events_id_seq, charity_events_schedule_id_seq, chip_ledger_chain_seq, clawbot_audit_log_id_seq, client_shell_telemetry_id_seq, club_entry_events_id_seq, club_profit_reconcile_log_id_seq, commander_home_group_share_log_id_seq, commander_home_group_view_log_id_seq, commander_home_join_attempts_id_seq, content_asset_use_id_seq, content_authors_id_seq, customization_operations_id_seq, daily_challenge_catalog_history_id_seq, db_saturation_selftest_log_id_seq, deep_stack_delete_attempts_id_seq, diamond_game_config_history_id_seq, diamond_reward_catalog_history_id_seq, employee_number_seq, engine_alerts_id_seq, game_live_history_id_seq, game_management_events_sequence_seq, geeves_missed_questions_id_seq, hand_id_seq, horse_hand_reviews_id_seq, horse_league_results_id_seq, horse_phrase_ledger_id_seq, horse_self_tune_log_id_seq, horse_thread_state_id_seq, leaderboard_payout_failures_id_seq, notification_prompt_log_id_seq, page_followers_id_seq, personas_id_seq, pgrst_reload_watchdog_log_id_seq, phase22_rls_table_audit_id_seq, phase22_secdef_grant_audit_id_seq, phase22_view_security_audit_id_seq, player_number_seq, poker_diamond_tournament_ledger_id_seq, poker_series_id_seq, poker_tour_series_events_id_seq, poker_venues_id_seq, probe_heartbeats_id_seq, profiles_player_number_seq, public_player_number_seq, qr_code_scans_id_seq, scrape_source_registry_id_seq, scraper_metrics_id_seq, signup_errors_archive_id_seq, signup_errors_id_seq, stable_hand_beats_id_seq, table_settings_changes_id_seq, tour_event_details_id_seq, tour_events_id_seq, tour_schedule_registry_id_seq, tour_schedule_sources_id_seq, tournament_schedule_spawns_id_seq, tournament_series_id_seq, trivia_diamond_award_limits_history_id_seq, venue_game_schedules_id_seq, venue_live_history_id_seq, venue_live_tables_id_seq, venue_news_id_seq, wheel_config_history_id_seq TO service_role;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE daily_mission_operations_id_seq TO anon;
GRANT UPDATE ON SEQUENCE daily_mission_operations_id_seq TO authenticated;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE daily_mission_operations_id_seq TO service_role;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE ca_dropped_index_ledger_id_seq, ca_seat_guard_dryrun_id_seq, cashier_operations_id_seq, client_crash_log_id_seq, managed_game_contract_versions_id_seq TO service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE ad_event, anti_farming_ips, arcade_duel_queue, arcade_sessions, arena_sessions, article_bookmarks, avatar_unlocks, bankroll_alerts, bankroll_assistant_memory, bankroll_goals, bankroll_history, bankroll_ledger, bankroll_locations, bankroll_rule_violations, bankroll_rules, bankroll_segments, bankroll_sessions, bankroll_transfers, bankroll_trips, blacklists, blocked_users, bus_event_log, celebration_queue, charity_events_schedule, client_shell_telemetry, clip_library, club_announcements, club_challenges, club_chat, club_shop_items, collusion_tracking, commander_api_keys, commander_clock_presets, commander_club_announcements, commander_comp_rates, commander_comp_redemptions, commander_comp_transactions, commander_dealer_marketplace, commander_dealer_rotations, commander_dealers, commander_equipment_rentals, commander_export_jobs, commander_floor_calls, commander_hand_history, commander_incidents, commander_leaderboards, commander_notifications, commander_player_preferences, commander_player_sessions, commander_player_stats, commander_post_comments, commander_progressive_jackpots, commander_promotion_awards, commander_promotions, commander_push_subscriptions, commander_self_exclusions, commander_service_requests, commander_spending_limits, commander_staff, commander_streams, commander_table_displays, commander_table_seats, commander_table_sessions, commander_time_purchases, commander_tournament_entries, commander_tournament_points, commander_tournament_templates, commander_tournaments, commander_venue_followers, commander_venue_review_flags, commander_venue_review_helpful, commander_venue_reviews, commander_wait_time_predictions, commander_waitlist, commander_waitlist_group_members, commander_waitlist_groups, content_authors, conversations, crew_members, crews, cron_health_log, cron_locks, custom_avatar_gallery, dealer_calendar_events, dealer_documents, direct_messages, endless_high_scores, favorite_tables, follows, friend_challenges, friend_requests, geeves_conversations, geofence_visits, god_mode_hand_history, god_mode_sessions, god_mode_user_session, hand_private_state, jarvis_conversations, jarvis_leak_alerts, jarvis_weekly_reports, live_ban_audit, live_bans, live_comments, live_gifts, live_help_conversations, live_help_messages, live_help_tickets, live_pins, live_reactions, live_sessions, live_signaling, live_viewers, memory_challenge_completions, mentions, messages, messenger_admin_messages, messenger_bookmarks, messenger_call_signals, messenger_conversation_labels, messenger_conversations, messenger_favorites, messenger_labels, messenger_messages, messenger_participants, messenger_reactions, messenger_reminders, messenger_reports, messenger_scheduled, messenger_templates, messenger_themes, news_bookmarks, news_read_later, newsletter_subscribers, notification_preferences, notification_reads, notifications, opponent_profiles, page_activity, page_followers, pb_calibration_profiles, pb_hands, pb_profiles, pb_sessions, pb_stats, player_notes, player_search_preferences, player_stats, poker_events, poker_goals, poker_near_me_favorites, poker_near_me_search_history, poker_seat_preferences, poker_series, poker_session_stats, poker_sessions, poker_table_layouts, poker_tables, poker_tour_series_events, premium_feature_access, profile_picture_history, promotion_claims, push_subscriptions, qr_code_scans, rate_limit_buckets, referral_codes, referrals, sandbox_analytics, sandbox_bookmarks, sandbox_coach_results, sandbox_equity_history, sandbox_quiz_results, sandbox_saved_hands, sandbox_sessions, sandbox_shared_scenarios, sandbox_templates, saved_reels, scheduled_lives, scraper_runs, session_chat_messages, session_history, share_events, sms_otp_codes, social_comment_likes, social_comments, social_connections, social_follows, social_interactions, social_likes, social_media, social_media_library, social_messages, social_page_comment_likes, social_page_followers, social_page_post_comments, social_page_post_likes, social_page_posts, social_page_reports, social_page_reviews, social_pages, social_post_comments, social_posts, social_reels, social_stories, social_story_views, solution_bookmarks, solver_queue, staking_arrangements, staking_sessions, study_rooms, survival_progress, table_chat, table_chat_mutes, table_hole_cards, table_seats, table_templates, tables, throw_usage, tilt_journal, time_bank, toke_downs, toke_expenses, toke_gig_days, toke_gigs, tour_schedule_sources, tour_stop_events, tournament_alert_preferences, tournament_deal_votes, tournament_registration_approvals, tournament_series, tournament_waitlists, tournaments, training_achievement_definitions, training_custom_drills, training_events, training_hand_history, training_question_reports, training_scenarios, training_tool_records, trips, trivia_survival_runs, trivia_tournament_notifications, union_applications, union_clubs, union_leave_requests, unions, user_albums, user_assistant_stats, user_avatars, user_blocks, user_bookmarks, user_devices, user_feedback, user_leaks, user_media, user_mfa_factors, user_notification_preferences, user_notifications, user_poker_stats, user_preferences, user_progress, user_pwa_alerts, user_reports, user_sessions, user_stats, user_streaks, user_table_settings, user_theme_settings, user_training_leaks, user_venue_checkins, users, venue_checkins, venue_daily_tournaments, venue_game_alerts, venue_game_schedules, venue_live_tables, venue_reviews, venue_verification_log, venues, video_analysis, video_favorites, video_generation_queue, video_playlist_items, video_playlists, video_watch_history, video_watch_later, vip_feature_dismissals, vip_feature_usage, w2g_forms, wallets, wishlists TO anon;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE ad_event, anti_farming_ips, arcade_duel_queue, arcade_sessions, arena_sessions, article_bookmarks, avatar_unlocks, bankroll_alerts, bankroll_assistant_memory, bankroll_goals, bankroll_history, bankroll_ledger, bankroll_locations, bankroll_rule_violations, bankroll_rules, bankroll_segments, bankroll_sessions, bankroll_transfers, bankroll_trips, blacklists, blocked_users, bus_event_log, celebration_queue, charity_events_schedule, client_shell_telemetry, clip_library, club_announcements, club_challenges, club_chat, club_shop_items, collusion_tracking, commander_api_keys, commander_clock_presets, commander_club_announcements, commander_comp_rates, commander_comp_redemptions, commander_comp_transactions, commander_dealer_marketplace, commander_dealer_rotations, commander_dealers, commander_equipment_rentals, commander_export_jobs, commander_floor_calls, commander_hand_history, commander_incidents, commander_leaderboards, commander_notifications, commander_player_preferences, commander_player_sessions, commander_player_stats, commander_post_comments, commander_progressive_jackpots, commander_promotion_awards, commander_promotions, commander_push_subscriptions, commander_self_exclusions, commander_service_requests, commander_spending_limits, commander_staff, commander_streams, commander_table_displays, commander_table_seats, commander_table_sessions, commander_time_purchases, commander_tournament_entries, commander_tournament_points, commander_tournament_templates, commander_tournaments, commander_venue_followers, commander_venue_review_flags, commander_venue_review_helpful, commander_venue_reviews, commander_wait_time_predictions, commander_waitlist, commander_waitlist_group_members, commander_waitlist_groups, content_authors, conversations, crew_members, crews, cron_health_log, cron_locks, custom_avatar_gallery, dealer_calendar_events, dealer_documents, direct_messages, endless_high_scores, favorite_tables, follows, friend_challenges, friend_requests, geeves_conversations, geofence_visits, god_mode_hand_history, god_mode_sessions, god_mode_user_session, hand_private_state, jarvis_conversations, jarvis_leak_alerts, jarvis_weekly_reports, live_ban_audit, live_bans, live_comments, live_gifts, live_help_conversations, live_help_messages, live_help_tickets, live_pins, live_reactions, live_sessions, live_signaling, live_viewers, memory_challenge_completions, mentions, messages, messenger_admin_messages, messenger_bookmarks, messenger_call_signals, messenger_conversation_labels, messenger_conversations, messenger_favorites, messenger_labels, messenger_messages, messenger_participants, messenger_reactions, messenger_reminders, messenger_reports, messenger_scheduled, messenger_templates, messenger_themes, news_bookmarks, news_read_later, newsletter_subscribers, notification_preferences, notification_reads, notifications, opponent_profiles, page_activity, page_followers, pb_calibration_profiles, pb_hands, pb_profiles, pb_sessions, pb_stats, player_notes, player_search_preferences, player_stats, poker_events, poker_goals, poker_near_me_favorites, poker_near_me_search_history, poker_seat_preferences, poker_series, poker_session_stats, poker_sessions, poker_table_layouts, poker_tables, poker_tour_series_events, premium_feature_access, profile_picture_history, promotion_claims, push_subscriptions, qr_code_scans, rate_limit_buckets, referral_codes, referrals, sandbox_analytics, sandbox_bookmarks, sandbox_coach_results, sandbox_equity_history, sandbox_quiz_results, sandbox_saved_hands, sandbox_sessions, sandbox_shared_scenarios, sandbox_templates, saved_reels, scheduled_lives, scraper_runs, session_chat_messages, session_history, share_events, sms_otp_codes, social_comment_likes, social_comments, social_connections, social_follows, social_interactions, social_likes, social_media, social_media_library, social_messages, social_page_comment_likes, social_page_followers, social_page_post_comments, social_page_post_likes, social_page_posts, social_page_reports, social_page_reviews, social_pages, social_post_comments, social_posts, social_reels, social_stories, social_story_views, solution_bookmarks, solver_queue, staking_arrangements, staking_sessions, study_rooms, survival_progress, table_chat, table_chat_mutes, table_hole_cards, table_seats, table_templates, tables, throw_usage, tilt_journal, time_bank, toke_downs, toke_expenses, toke_gig_days, toke_gigs, tour_schedule_sources, tour_stop_events, tournament_alert_preferences, tournament_deal_votes, tournament_registration_approvals, tournament_series, tournament_waitlists, tournaments, training_achievement_definitions, training_custom_drills, training_events, training_hand_history, training_question_reports, training_scenarios, training_tool_records, trips, trivia_survival_runs, trivia_tournament_notifications, union_applications, union_clubs, union_leave_requests, unions, user_albums, user_assistant_stats, user_avatars, user_blocks, user_bookmarks, user_devices, user_feedback, user_leaks, user_media, user_mfa_factors, user_notification_preferences, user_notifications, user_poker_stats, user_preferences, user_progress, user_pwa_alerts, user_reports, user_sessions, user_stats, user_streaks, user_table_settings, user_theme_settings, user_training_leaks, user_venue_checkins, users, venue_checkins, venue_daily_tournaments, venue_game_alerts, venue_game_schedules, venue_live_tables, venue_reviews, venue_verification_log, venues, video_analysis, video_favorites, video_generation_queue, video_playlist_items, video_playlists, video_watch_history, video_watch_later, vip_feature_dismissals, vip_feature_usage, w2g_forms, wallets, wishlists TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE ad_event, anti_farming_ips, arcade_duel_queue, arcade_sessions, arena_sessions, article_bookmarks, avatar_unlocks, bankroll_alerts, bankroll_assistant_memory, bankroll_goals, bankroll_history, bankroll_ledger, bankroll_locations, bankroll_rule_violations, bankroll_rules, bankroll_segments, bankroll_sessions, bankroll_transfers, bankroll_trips, blacklists, blocked_users, bus_event_log, celebration_queue, charity_events_schedule, client_shell_telemetry, clip_library, club_announcements, club_challenges, club_chat, club_shop_items, collusion_tracking, commander_api_keys, commander_clock_presets, commander_club_announcements, commander_comp_rates, commander_comp_redemptions, commander_comp_transactions, commander_dealer_marketplace, commander_dealer_rotations, commander_dealers, commander_equipment_rentals, commander_export_jobs, commander_floor_calls, commander_hand_history, commander_incidents, commander_leaderboards, commander_notifications, commander_player_preferences, commander_player_sessions, commander_player_stats, commander_post_comments, commander_progressive_jackpots, commander_promotion_awards, commander_promotions, commander_push_subscriptions, commander_self_exclusions, commander_service_requests, commander_spending_limits, commander_staff, commander_streams, commander_table_displays, commander_table_seats, commander_table_sessions, commander_time_purchases, commander_tournament_entries, commander_tournament_points, commander_tournament_templates, commander_tournaments, commander_venue_followers, commander_venue_review_flags, commander_venue_review_helpful, commander_venue_reviews, commander_wait_time_predictions, commander_waitlist, commander_waitlist_group_members, commander_waitlist_groups, content_authors, conversations, crew_members, crews, cron_health_log, cron_locks, custom_avatar_gallery, dealer_calendar_events, dealer_documents, direct_messages, endless_high_scores, favorite_tables, follows, friend_challenges, friend_requests, geeves_conversations, geofence_visits, god_mode_hand_history, god_mode_sessions, god_mode_user_session, hand_private_state, jarvis_conversations, jarvis_leak_alerts, jarvis_weekly_reports, live_ban_audit, live_bans, live_comments, live_gifts, live_help_conversations, live_help_messages, live_help_tickets, live_pins, live_reactions, live_sessions, live_signaling, live_viewers, memory_challenge_completions, mentions, messages, messenger_admin_messages, messenger_bookmarks, messenger_call_signals, messenger_conversation_labels, messenger_conversations, messenger_favorites, messenger_labels, messenger_messages, messenger_participants, messenger_reactions, messenger_reminders, messenger_reports, messenger_scheduled, messenger_templates, messenger_themes, news_bookmarks, news_read_later, newsletter_subscribers, notification_preferences, notification_reads, notifications, opponent_profiles, page_activity, page_followers, pb_calibration_profiles, pb_hands, pb_profiles, pb_sessions, pb_stats, player_notes, player_search_preferences, player_stats, poker_events, poker_goals, poker_near_me_favorites, poker_near_me_search_history, poker_seat_preferences, poker_series, poker_session_stats, poker_sessions, poker_table_layouts, poker_tables, poker_tour_series_events, premium_feature_access, profile_picture_history, promotion_claims, push_subscriptions, qr_code_scans, rate_limit_buckets, referral_codes, referrals, sandbox_analytics, sandbox_bookmarks, sandbox_coach_results, sandbox_equity_history, sandbox_quiz_results, sandbox_saved_hands, sandbox_sessions, sandbox_shared_scenarios, sandbox_templates, saved_reels, scheduled_lives, scraper_runs, session_chat_messages, session_history, share_events, sms_otp_codes, social_comment_likes, social_comments, social_connections, social_follows, social_interactions, social_likes, social_media, social_media_library, social_messages, social_page_comment_likes, social_page_followers, social_page_post_comments, social_page_post_likes, social_page_posts, social_page_reports, social_page_reviews, social_pages, social_post_comments, social_posts, social_reels, social_stories, social_story_views, solution_bookmarks, solver_queue, staking_arrangements, staking_sessions, study_rooms, survival_progress, table_chat, table_chat_mutes, table_hole_cards, table_seats, table_templates, tables, throw_usage, tilt_journal, time_bank, toke_downs, toke_expenses, toke_gig_days, toke_gigs, tour_schedule_sources, tour_stop_events, tournament_alert_preferences, tournament_deal_votes, tournament_registration_approvals, tournament_series, tournament_waitlists, tournaments, training_achievement_definitions, training_custom_drills, training_events, training_hand_history, training_question_reports, training_scenarios, training_tool_records, trips, trivia_survival_runs, trivia_tournament_notifications, union_applications, union_clubs, union_leave_requests, unions, user_albums, user_assistant_stats, user_avatars, user_blocks, user_bookmarks, user_devices, user_feedback, user_leaks, user_media, user_mfa_factors, user_notification_preferences, user_notifications, user_poker_stats, user_preferences, user_progress, user_pwa_alerts, user_reports, user_sessions, user_stats, user_streaks, user_table_settings, user_theme_settings, user_training_leaks, user_venue_checkins, users, venue_checkins, venue_daily_tournaments, venue_game_alerts, venue_game_schedules, venue_live_tables, venue_reviews, venue_verification_log, venues, video_analysis, video_favorites, video_generation_queue, video_playlist_items, video_playlists, video_watch_history, video_watch_later, vip_feature_dismissals, vip_feature_usage, w2g_forms, wallets, wishlists TO service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE training_study_group_members, training_study_group_messages, training_study_groups TO anon;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE training_study_group_members, training_study_group_messages, training_study_groups TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE training_study_group_members, training_study_group_messages, training_study_groups TO service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, TRIGGER, UPDATE ON TABLE live_streams TO anon;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, TRIGGER, UPDATE ON TABLE live_streams TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE live_streams TO service_role;
GRANT DELETE, INSERT, MAINTAIN, SELECT, UPDATE ON TABLE commander_home_game_photos, commander_home_game_reviews, commander_home_game_tables, commander_home_game_templates, commander_home_games, commander_home_group_follows, commander_home_group_promotion_requests, commander_home_group_share_log, commander_home_group_view_log, commander_home_join_attempts, commander_home_poll_votes, commander_home_polls, commander_home_post_comments, commander_home_post_likes, commander_home_posts, commander_home_rsvps, commander_home_seat_reservations, commander_home_seats, home_game_vouches TO anon;
GRANT DELETE, INSERT, MAINTAIN, SELECT, UPDATE ON TABLE commander_home_game_photos, commander_home_game_reviews, commander_home_game_tables, commander_home_game_templates, commander_home_games, commander_home_group_follows, commander_home_group_promotion_requests, commander_home_group_share_log, commander_home_group_view_log, commander_home_join_attempts, commander_home_poll_votes, commander_home_polls, commander_home_post_comments, commander_home_post_likes, commander_home_posts, commander_home_rsvps, commander_home_seat_reservations, commander_home_seats, home_game_vouches TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE commander_home_game_photos, commander_home_game_reviews, commander_home_game_tables, commander_home_game_templates, commander_home_games, commander_home_group_follows, commander_home_group_promotion_requests, commander_home_group_share_log, commander_home_group_view_log, commander_home_join_attempts, commander_home_poll_votes, commander_home_polls, commander_home_post_comments, commander_home_post_likes, commander_home_posts, commander_home_rsvps, commander_home_seat_reservations, commander_home_seats, home_game_vouches TO service_role;
GRANT DELETE, INSERT, MAINTAIN, UPDATE ON TABLE commander_home_content_reports TO anon;
GRANT DELETE, INSERT, MAINTAIN, SELECT, UPDATE ON TABLE commander_home_content_reports TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE commander_home_content_reports TO service_role;
GRANT DELETE, INSERT, MAINTAIN, UPDATE ON TABLE commander_home_audit_log, commander_home_members TO anon;
GRANT DELETE, INSERT, MAINTAIN, UPDATE ON TABLE commander_home_audit_log, commander_home_members TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE commander_home_audit_log, commander_home_members TO service_role;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT ON TABLE credit_requests TO anon;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT ON TABLE credit_requests TO authenticated;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT ON TABLE credit_requests TO service_role;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE club_members TO anon;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE club_members TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE club_members TO service_role;
GRANT MAINTAIN ON TABLE memory_game_sessions, tournament_payouts TO anon;
GRANT MAINTAIN, SELECT ON TABLE memory_game_sessions, tournament_payouts TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE memory_game_sessions, tournament_payouts TO service_role;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE audit_trail, ca_seat_stack_exits, club_hand_daily, club_hand_daily_shard, club_opening_setup_funding, club_opening_setups, club_wallet_transactions, clubs, daily_challenge_catalog, daily_trivia_plays, diamond_purchases, feature_pricing, hand_actions, hand_players, hands, jarvis_training_sessions, jarvis_user_training_profile, leaderboard_payout_batches, leaderboard_payout_failures, leaderboard_payouts, ledger_reconcile_log, spin_tier_spec, training_daily_bonus, training_leaderboard, training_level_history, training_progress, training_sessions, training_spaced_repetition, training_streaks, training_tournament_entries, training_user_achievements, training_user_challenges, transaction_idempotency_keys, trivia_category_mastery, trivia_diamond_award_limits, trivia_item_transactions, trivia_prize_wheel_spins, trivia_pvp_stats, trivia_question_result_events, trivia_scores, trivia_streaks, trivia_user_items, trivia_user_question_history, union_wallet_transactions, user_daily_challenges, user_level_progress, user_question_history, user_seen_questions, v_ca_suspense_balance, v_insurance_activity, v_insurance_pnl, v_openclaw_job_staleness, v_spin_draw_distribution_7d, vip_reward_catalog, vip_reward_claims, wallet_credit_idempotency TO anon;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE audit_trail, ca_seat_stack_exits, club_hand_daily, club_hand_daily_shard, club_opening_setup_funding, club_opening_setups, club_wallet_transactions, clubs, daily_challenge_catalog, daily_trivia_plays, diamond_purchases, feature_pricing, hand_actions, hand_players, hands, jarvis_training_sessions, jarvis_user_training_profile, leaderboard_payout_batches, leaderboard_payout_failures, leaderboard_payouts, ledger_reconcile_log, spin_tier_spec, training_daily_bonus, training_leaderboard, training_level_history, training_progress, training_sessions, training_spaced_repetition, training_streaks, training_tournament_entries, training_user_achievements, training_user_challenges, transaction_idempotency_keys, trivia_category_mastery, trivia_diamond_award_limits, trivia_item_transactions, trivia_prize_wheel_spins, trivia_pvp_stats, trivia_question_result_events, trivia_scores, trivia_streaks, trivia_user_items, trivia_user_question_history, union_wallet_transactions, user_daily_challenges, user_level_progress, user_question_history, user_seen_questions, v_ca_suspense_balance, v_insurance_activity, v_insurance_pnl, v_openclaw_job_staleness, v_spin_draw_distribution_7d, vip_reward_catalog, vip_reward_claims, wallet_credit_idempotency TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE audit_trail, ca_seat_stack_exits, club_hand_daily, club_hand_daily_shard, club_opening_setup_funding, club_opening_setups, club_wallet_transactions, clubs, daily_challenge_catalog, daily_trivia_plays, diamond_purchases, feature_pricing, hand_actions, hand_players, hands, jarvis_training_sessions, jarvis_user_training_profile, leaderboard_payout_batches, leaderboard_payout_failures, leaderboard_payouts, ledger_reconcile_log, spin_tier_spec, training_daily_bonus, training_leaderboard, training_level_history, training_progress, training_sessions, training_spaced_repetition, training_streaks, training_tournament_entries, training_user_achievements, training_user_challenges, transaction_idempotency_keys, trivia_category_mastery, trivia_diamond_award_limits, trivia_item_transactions, trivia_prize_wheel_spins, trivia_pvp_stats, trivia_question_result_events, trivia_scores, trivia_streaks, trivia_user_items, trivia_user_question_history, union_wallet_transactions, user_daily_challenges, user_level_progress, user_question_history, user_seen_questions, v_ca_suspense_balance, v_insurance_activity, v_insurance_pnl, v_openclaw_job_staleness, v_spin_draw_distribution_7d, vip_reward_catalog, vip_reward_claims, wallet_credit_idempotency TO service_role;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE tournament_players TO anon;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE tournament_players TO authenticated;
GRANT DELETE, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE tournament_players TO service_role;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE training_answers, training_attempt_hands TO anon;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE training_answers, training_attempt_hands TO authenticated;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE training_answers, training_attempt_hands TO service_role;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE training_attempts, training_hand_replay TO anon;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE training_attempts, training_hand_replay TO authenticated;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE training_attempts, training_hand_replay TO service_role;
GRANT MAINTAIN, REFERENCES, TRIGGER ON TABLE agents, bomb_pot_award_units, chip_transactions, tournament_tickets TO anon;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE agents, bomb_pot_award_units, chip_transactions, tournament_tickets TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE agents, bomb_pot_award_units, chip_transactions, tournament_tickets TO service_role;
GRANT MAINTAIN, SELECT ON TABLE bbj_contributions, bbj_daily_user, bbj_hand_evidence_log, bbj_payout_recipients, bbj_payouts, bbj_pools, bbj_qualifying_hands, bbj_snapshot_alert_collapse_log, bbj_stakes_tiers, bbj_unclaimed_shares, bbj_winners, chip_ledger, club_agents, club_daily_stats, club_leaderboard_settings, live_stream_analytics, memory_leaderboards, pipeline_stats, player_sessions, sandbox_coach_accuracy, share_streaks, special_bonuses, table_waitlist, tours_due_for_refresh, unified_events_calendar, v_spin_tier_availability, v_yt_jobs_health, v_yt_pipeline_health, video_library_health, wallet_transactions TO anon;
GRANT MAINTAIN, SELECT ON TABLE bbj_contributions, bbj_daily_user, bbj_hand_evidence_log, bbj_payout_recipients, bbj_payouts, bbj_pools, bbj_qualifying_hands, bbj_snapshot_alert_collapse_log, bbj_stakes_tiers, bbj_unclaimed_shares, bbj_winners, chip_ledger, club_agents, club_daily_stats, club_leaderboard_settings, live_stream_analytics, memory_leaderboards, pipeline_stats, player_sessions, sandbox_coach_accuracy, share_streaks, special_bonuses, table_waitlist, tours_due_for_refresh, unified_events_calendar, v_spin_tier_availability, v_yt_jobs_health, v_yt_pipeline_health, video_library_health, wallet_transactions TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE bbj_contributions, bbj_daily_user, bbj_hand_evidence_log, bbj_payout_recipients, bbj_payouts, bbj_pools, bbj_qualifying_hands, bbj_snapshot_alert_collapse_log, bbj_stakes_tiers, bbj_unclaimed_shares, bbj_winners, chip_ledger, club_agents, club_daily_stats, club_leaderboard_settings, live_stream_analytics, memory_leaderboards, pipeline_stats, player_sessions, sandbox_coach_accuracy, share_streaks, special_bonuses, table_waitlist, tours_due_for_refresh, unified_events_calendar, v_spin_tier_availability, v_yt_jobs_health, v_yt_pipeline_health, video_library_health, wallet_transactions TO service_role;
GRANT MAINTAIN, SELECT ON TABLE tournament_bounties TO anon;
GRANT MAINTAIN, SELECT ON TABLE tournament_bounties TO authenticated;
GRANT MAINTAIN, SELECT ON TABLE tournament_bounties TO service_role;
GRANT MAINTAIN, SELECT, TRIGGER ON TABLE diamond_reward_claims, diamond_transactions TO anon;
GRANT MAINTAIN, SELECT, TRIGGER ON TABLE diamond_reward_claims, diamond_transactions TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE diamond_reward_claims, diamond_transactions TO service_role;
GRANT REFERENCES, SELECT ON TABLE cashout_requests, chip_escrow TO anon;
GRANT REFERENCES, SELECT ON TABLE cashout_requests, chip_escrow TO authenticated;
GRANT MAINTAIN, REFERENCES, SELECT ON TABLE cashout_requests, chip_escrow TO service_role;
GRANT REFERENCES, SELECT, TRIGGER ON TABLE _pps_backfill_state, abuse_logs, action_audit_logs, action_log, active_tables, ad_advertiser, ad_campaign, ad_catalog, ad_event_retention_policy, ad_placement, ad_rate_card, admin_audit_log, anti_cheat_events, api_idempotency, arcade_duels, arcade_games, arcade_jackpot, arena_matches, arena_orbs, bad_beat_jackpots, bot_profiles, ca_break_scorecards, ca_chip_baseline, ca_club_player_daily, ca_club_tournament_daily, ca_club_tournament_player_daily, ca_ddl_events, ca_financial_epochs, ca_freeze_circulation_marks, ca_frozen_pool_baseline_changes, ca_hand_player_stat_repair_state, ca_hand_transfers, ca_ledger_maintenance_kinds, ca_ledger_write_failures, ca_operator_player_notes, ca_operator_player_tags, ca_pgrst_reload_log, ca_player_restrictions, ca_rake_schedule, ca_rake_tier, ca_restriction_observations, ca_stat_distribution, ca_treasury_baseline, card_slide_usage, chat_filter_words, chat_moderation_actions, chat_mutes, chip_escrow_holds, clawbot_audit_log, clawbot_task_state, clip_usage_log, club_arena_audit_logs, club_creation_bonuses, club_creation_requests, club_diamond_wallets, club_financial_summary, club_game_seats, club_join_idempotency, club_level_thresholds, club_live_games, club_member_daily_stats, club_member_table_state, club_rake_daily_user, club_rake_rollup_complete, club_shop_inventory, club_shop_purchases, club_stats_rebuild_log, club_wallets, commander_activity_log, commander_admin_pins, commander_admin_settings, commander_analytics_daily, commander_audit_logs, commander_buyin_transactions, commander_cash_transactions, commander_checkins, commander_comp_balances, commander_day_closes, commander_dealer_bookings, commander_equipment_rental_orders, commander_escrow_transactions, commander_freeroll_qualifications, commander_freerolls, commander_game_types, commander_games, commander_high_hands, commander_leaderboard_entries, commander_leads, commander_league_standings, commander_leagues, commander_member_comp_log, commander_members, commander_membership_plans, commander_notification_log, commander_onboarding_leads, commander_pilot_venues, commander_player_reputation, commander_player_reputation_scores, commander_print_jobs, commander_rate_limits, commander_room_presets, commander_seat_preferences, commander_seats, commander_sessions, commander_shift_handoffs, commander_staff_shifts, commander_subscriptions, commander_system_health, commander_system_log, commander_table_ratings, commander_tables, commander_tax_events, commander_time_clock, commander_time_sessions, commander_tournament_leaderboards, commander_venue_photos, commander_venue_posts, commander_venue_settings, commander_waitlist_history, commission_rate_audit, content_asset_use, content_schedule, content_settings, content_sources, content_stats, cosmetic_catalog, credit_assignments, credit_invoices, credit_payments, cron_execution_log, daemon_state, daily_challenges, daily_spins, data_audit_log, deep_stack_delete_attempts, deploy_alerts, deprecated_tables, diamond_arena_events, diamond_ledger, diamond_wallets, disputes, engine_leader, engine_maintenance_break_log, engine_recovery_events, engine_state_snapshot, engine_tournament_leases, execution_audit_logs, fct_portfolio, feature_purchases, fee_requeue_log, financial_alerts, financial_health_checks, flash_pool_players, flash_pools, game_action_idempotency_keys, game_formats, game_live_history, game_registry, game_tables, games, gdpr_deletion_requests, geeves_analytics, geeves_answer_ratings, geeves_knowledge_cache, geeves_messages, geeves_missed_questions, grok_explanation_cache, gto_agg_progress, gto_scenarios, hand_audit_decisions, hand_histories, hand_history, hand_history_retention_policy, hendon_scrape_log, horse_brain_telemetry, horse_daily_audit, horse_daily_nets, horse_daily_play, horse_decision_latency, horse_error_log, horse_hand_reviews, horse_job_runs, horse_league_results, horse_mind_pairs, horse_mind_stats, horse_mind_stats_scoped, horse_opponent_reads, horse_post_modes, horse_relationships, horse_review_rollup, horse_self_tune_log, horse_session_analytics, horse_session_stats, horse_solver_agreement, horse_thread_state, horse_threat_intel, horse_tournament_daily, idempotency_keys, insurance_offer_events, insurance_transactions, jarvis_response_cache, kyc_events, leaderboard_entries, leak_review_state, live_game_confirmations, live_games, live_help_analytics, live_help_reactions, lucky_wheel_segments, member_fee_rollup, member_fee_rollup_state, memory_achievement_definitions, memory_charts_gold, memory_daily_challenges, money_flow_checkpoint, news_articles, news_push_log, newsletter_campaigns, notification_prompt_log, orb1_idempotency_keys, orbs, orders, page_claims, pending_calls, pending_fee_distributions, personas, pgrst_reload_watchdog_log, pipeline_runs, platform_policies, player_agent_assignments, player_position_stats, poker_clips, poker_hands, poker_news, poker_reels, poker_venues, poker_videos, post_briefs, posted_clips, posted_sports_clips, poy_leaderboard, privileged_function_lock, probe_heartbeats, promo_code_redemptions, promo_codes, promo_codes_used, promo_distributions, promo_vault_catalog, promo_vault_inventory, promo_vault_records, promo_wagering_ledger, promotion_leaderboards, promotions, purchase_history, push_dispatch_runs, push_outbox, pwa_prompt_log, rabbit_hunt_offers, rabbit_hunt_reveals, rake_attributions, rake_distribution_legs, rake_history, rake_rate_audit, rake_records, rakeback_distributions, rakeback_stats_applied, referral_milestone_claims, referral_redemptions, responsible_gaming_limits, responsible_gaming_sessions, reward_claims, reward_definitions, role_changes, sandbox_results, sandbox_weekly_spots, scrape_evidence, scrape_source_registry, scraper_metrics, scraper_watchdog_state, seed_reveals, seeded_content, settlement_idempotency_keys, settlement_invoices, settlement_journal, settlement_locks, seven_deuce_bounties, share_streak_rewards, signup_abuse_log, signup_errors, signup_errors_archive, slug_history, social_conversation_participants, social_conversations, social_pages_orphan_archive, spin_bonus_pools, spin_payout_ladder, spin_reserve_ledger, spin_unpaid_backpay_log, sports_clips, sso_bridge_tokens, stack_depth_configs, staff_claim_tokens, sticker_assets, stories, sub_agents, system_cache, system_logs, table_activity, table_addon_idempotency, table_cashout_history, table_pending_addons, table_sessions, theme_asset_unlocks, theme_unlocks, toke_entries, topic_cooldowns, tour_event_details, tour_events, tour_schedule_registry, tour_scrape_registry, tour_source_registry, tournament_conservation_baseline, tournament_payout_backfill_log, tournament_place_overpay_charges, tournament_place_renumbers, tournament_players_position_repair_20260901, tournament_rake_settlements, tournament_registrations, tournament_reminders_sent, tournament_results, tournament_schedule_spawns, tournament_schedules, tournament_survivor_rank_backfill, training_achievements, training_challenge_definitions, training_daily_challenges, training_drills, training_levels, training_tournaments, training_user_progress, trivia_category_health, trivia_quality_audits, trivia_regression_runs, union_admins, union_announcements, union_club_terms, union_creators, union_invoice_counters, union_pnl_settlements, union_presettlements, union_rake_ledger_checkpoint, union_rake_paid_daily_user, union_rake_rollup_days, union_rake_weekly, union_rakeback_log, union_settlement_floor, union_settlement_rounds, union_wallets, user_badges, user_bonus_progress, user_daily_rewards, user_daily_streaks, user_diamond_balance, user_diamonds, user_lucky_wheel_spins, user_tos_acceptances, v_backtest_summary, venue_aliases, venue_claims, venue_directory_enrichment_log, venue_duplicate_retirement_log, venue_game_snapshots, venue_live_history, venue_location_integrity_log, venue_location_integrity_state, venue_managers, venue_news, venue_tournament_schedules, video_clips, video_library_videos, villain_archetypes, vip_feature_usage_monthly, vip_plan_switches, vip_points, vip_points_carry, vip_points_ledger, vip_pricing, vip_subscriptions, wallet_audit_backfill_log TO anon;
GRANT REFERENCES, SELECT, TRIGGER ON TABLE _pps_backfill_state, abuse_logs, action_audit_logs, action_log, active_tables, ad_advertiser, ad_campaign, ad_catalog, ad_event_retention_policy, ad_placement, ad_rate_card, admin_audit_log, anti_cheat_events, api_idempotency, arcade_duels, arcade_games, arcade_jackpot, arena_matches, arena_orbs, bad_beat_jackpots, bot_profiles, ca_break_scorecards, ca_chip_baseline, ca_club_player_daily, ca_club_tournament_daily, ca_club_tournament_player_daily, ca_ddl_events, ca_financial_epochs, ca_freeze_circulation_marks, ca_frozen_pool_baseline_changes, ca_hand_player_stat_repair_state, ca_hand_transfers, ca_ledger_maintenance_kinds, ca_ledger_write_failures, ca_operator_player_notes, ca_operator_player_tags, ca_pgrst_reload_log, ca_player_restrictions, ca_rake_schedule, ca_rake_tier, ca_restriction_observations, ca_stat_distribution, ca_treasury_baseline, card_slide_usage, chat_filter_words, chat_moderation_actions, chat_mutes, chip_escrow_holds, clawbot_audit_log, clawbot_task_state, clip_usage_log, club_arena_audit_logs, club_creation_bonuses, club_creation_requests, club_diamond_wallets, club_financial_summary, club_game_seats, club_join_idempotency, club_level_thresholds, club_live_games, club_member_daily_stats, club_member_table_state, club_rake_daily_user, club_rake_rollup_complete, club_shop_inventory, club_shop_purchases, club_stats_rebuild_log, club_wallets, commander_activity_log, commander_admin_pins, commander_admin_settings, commander_analytics_daily, commander_audit_logs, commander_buyin_transactions, commander_cash_transactions, commander_checkins, commander_comp_balances, commander_day_closes, commander_dealer_bookings, commander_equipment_rental_orders, commander_escrow_transactions, commander_freeroll_qualifications, commander_freerolls, commander_game_types, commander_games, commander_high_hands, commander_leaderboard_entries, commander_leads, commander_league_standings, commander_leagues, commander_member_comp_log, commander_members, commander_membership_plans, commander_notification_log, commander_onboarding_leads, commander_pilot_venues, commander_player_reputation, commander_player_reputation_scores, commander_print_jobs, commander_rate_limits, commander_room_presets, commander_seat_preferences, commander_seats, commander_sessions, commander_shift_handoffs, commander_staff_shifts, commander_subscriptions, commander_system_health, commander_system_log, commander_table_ratings, commander_tables, commander_tax_events, commander_time_clock, commander_time_sessions, commander_tournament_leaderboards, commander_venue_photos, commander_venue_posts, commander_venue_settings, commander_waitlist_history, commission_rate_audit, content_asset_use, content_schedule, content_settings, content_sources, content_stats, cosmetic_catalog, credit_assignments, credit_invoices, credit_payments, cron_execution_log, daemon_state, daily_challenges, daily_spins, data_audit_log, deep_stack_delete_attempts, deploy_alerts, deprecated_tables, diamond_arena_events, diamond_ledger, diamond_wallets, disputes, engine_leader, engine_maintenance_break_log, engine_recovery_events, engine_state_snapshot, engine_tournament_leases, execution_audit_logs, fct_portfolio, feature_purchases, fee_requeue_log, financial_alerts, financial_health_checks, flash_pool_players, flash_pools, game_action_idempotency_keys, game_formats, game_live_history, game_registry, game_tables, games, gdpr_deletion_requests, geeves_analytics, geeves_answer_ratings, geeves_knowledge_cache, geeves_messages, geeves_missed_questions, grok_explanation_cache, gto_agg_progress, gto_scenarios, hand_audit_decisions, hand_histories, hand_history, hand_history_retention_policy, hendon_scrape_log, horse_brain_telemetry, horse_daily_audit, horse_daily_nets, horse_daily_play, horse_decision_latency, horse_error_log, horse_hand_reviews, horse_job_runs, horse_league_results, horse_mind_pairs, horse_mind_stats, horse_mind_stats_scoped, horse_opponent_reads, horse_post_modes, horse_relationships, horse_review_rollup, horse_self_tune_log, horse_session_analytics, horse_session_stats, horse_solver_agreement, horse_thread_state, horse_threat_intel, horse_tournament_daily, idempotency_keys, insurance_offer_events, insurance_transactions, jarvis_response_cache, kyc_events, leaderboard_entries, leak_review_state, live_game_confirmations, live_games, live_help_analytics, live_help_reactions, lucky_wheel_segments, member_fee_rollup, member_fee_rollup_state, memory_achievement_definitions, memory_charts_gold, memory_daily_challenges, money_flow_checkpoint, news_articles, news_push_log, newsletter_campaigns, notification_prompt_log, orb1_idempotency_keys, orbs, orders, page_claims, pending_calls, pending_fee_distributions, personas, pgrst_reload_watchdog_log, pipeline_runs, platform_policies, player_agent_assignments, player_position_stats, poker_clips, poker_hands, poker_news, poker_reels, poker_venues, poker_videos, post_briefs, posted_clips, posted_sports_clips, poy_leaderboard, privileged_function_lock, probe_heartbeats, promo_code_redemptions, promo_codes, promo_codes_used, promo_distributions, promo_vault_catalog, promo_vault_inventory, promo_vault_records, promo_wagering_ledger, promotion_leaderboards, promotions, purchase_history, push_dispatch_runs, push_outbox, pwa_prompt_log, rabbit_hunt_offers, rabbit_hunt_reveals, rake_attributions, rake_distribution_legs, rake_history, rake_rate_audit, rake_records, rakeback_distributions, rakeback_stats_applied, referral_milestone_claims, referral_redemptions, responsible_gaming_limits, responsible_gaming_sessions, reward_claims, reward_definitions, role_changes, sandbox_results, sandbox_weekly_spots, scrape_evidence, scrape_source_registry, scraper_metrics, scraper_watchdog_state, seed_reveals, seeded_content, settlement_idempotency_keys, settlement_invoices, settlement_journal, settlement_locks, seven_deuce_bounties, share_streak_rewards, signup_abuse_log, signup_errors, signup_errors_archive, slug_history, social_conversation_participants, social_conversations, social_pages_orphan_archive, spin_bonus_pools, spin_payout_ladder, spin_reserve_ledger, spin_unpaid_backpay_log, sports_clips, sso_bridge_tokens, stack_depth_configs, staff_claim_tokens, sticker_assets, stories, sub_agents, system_cache, system_logs, table_activity, table_addon_idempotency, table_cashout_history, table_pending_addons, table_sessions, theme_asset_unlocks, theme_unlocks, toke_entries, topic_cooldowns, tour_event_details, tour_events, tour_schedule_registry, tour_scrape_registry, tour_source_registry, tournament_conservation_baseline, tournament_payout_backfill_log, tournament_place_overpay_charges, tournament_place_renumbers, tournament_players_position_repair_20260901, tournament_rake_settlements, tournament_registrations, tournament_reminders_sent, tournament_results, tournament_schedule_spawns, tournament_schedules, tournament_survivor_rank_backfill, training_achievements, training_challenge_definitions, training_daily_challenges, training_drills, training_levels, training_tournaments, training_user_progress, trivia_category_health, trivia_quality_audits, trivia_regression_runs, union_admins, union_announcements, union_club_terms, union_creators, union_invoice_counters, union_pnl_settlements, union_presettlements, union_rake_ledger_checkpoint, union_rake_paid_daily_user, union_rake_rollup_days, union_rake_weekly, union_rakeback_log, union_settlement_floor, union_settlement_rounds, union_wallets, user_badges, user_bonus_progress, user_daily_rewards, user_daily_streaks, user_diamond_balance, user_diamonds, user_lucky_wheel_spins, user_tos_acceptances, v_backtest_summary, venue_aliases, venue_claims, venue_directory_enrichment_log, venue_duplicate_retirement_log, venue_game_snapshots, venue_live_history, venue_location_integrity_log, venue_location_integrity_state, venue_managers, venue_news, venue_tournament_schedules, video_clips, video_library_videos, villain_archetypes, vip_feature_usage_monthly, vip_plan_switches, vip_points, vip_points_carry, vip_points_ledger, vip_pricing, vip_subscriptions, wallet_audit_backfill_log TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE _pps_backfill_state, abuse_logs, action_audit_logs, action_log, active_tables, ad_advertiser, ad_campaign, ad_catalog, ad_event_retention_policy, ad_placement, ad_rate_card, admin_audit_log, anti_cheat_events, api_idempotency, arcade_duels, arcade_games, arcade_jackpot, arena_matches, arena_orbs, bad_beat_jackpots, bot_profiles, ca_break_scorecards, ca_chip_baseline, ca_club_player_daily, ca_club_tournament_daily, ca_club_tournament_player_daily, ca_ddl_events, ca_financial_epochs, ca_freeze_circulation_marks, ca_frozen_pool_baseline_changes, ca_hand_player_stat_repair_state, ca_hand_transfers, ca_ledger_maintenance_kinds, ca_ledger_write_failures, ca_operator_player_notes, ca_operator_player_tags, ca_pgrst_reload_log, ca_player_restrictions, ca_rake_schedule, ca_rake_tier, ca_restriction_observations, ca_stat_distribution, ca_treasury_baseline, card_slide_usage, chat_filter_words, chat_moderation_actions, chat_mutes, chip_escrow_holds, clawbot_audit_log, clawbot_task_state, clip_usage_log, club_arena_audit_logs, club_creation_bonuses, club_creation_requests, club_diamond_wallets, club_financial_summary, club_game_seats, club_join_idempotency, club_level_thresholds, club_live_games, club_member_daily_stats, club_member_table_state, club_rake_daily_user, club_rake_rollup_complete, club_shop_inventory, club_shop_purchases, club_stats_rebuild_log, club_wallets, commander_activity_log, commander_admin_pins, commander_admin_settings, commander_analytics_daily, commander_audit_logs, commander_buyin_transactions, commander_cash_transactions, commander_checkins, commander_comp_balances, commander_day_closes, commander_dealer_bookings, commander_equipment_rental_orders, commander_escrow_transactions, commander_freeroll_qualifications, commander_freerolls, commander_game_types, commander_games, commander_high_hands, commander_leaderboard_entries, commander_leads, commander_league_standings, commander_leagues, commander_member_comp_log, commander_members, commander_membership_plans, commander_notification_log, commander_onboarding_leads, commander_pilot_venues, commander_player_reputation, commander_player_reputation_scores, commander_print_jobs, commander_rate_limits, commander_room_presets, commander_seat_preferences, commander_seats, commander_sessions, commander_shift_handoffs, commander_staff_shifts, commander_subscriptions, commander_system_health, commander_system_log, commander_table_ratings, commander_tables, commander_tax_events, commander_time_clock, commander_time_sessions, commander_tournament_leaderboards, commander_venue_photos, commander_venue_posts, commander_venue_settings, commander_waitlist_history, commission_rate_audit, content_asset_use, content_schedule, content_settings, content_sources, content_stats, cosmetic_catalog, credit_assignments, credit_invoices, credit_payments, cron_execution_log, daemon_state, daily_challenges, daily_spins, data_audit_log, deep_stack_delete_attempts, deploy_alerts, deprecated_tables, diamond_arena_events, diamond_ledger, diamond_wallets, disputes, engine_leader, engine_maintenance_break_log, engine_recovery_events, engine_state_snapshot, engine_tournament_leases, execution_audit_logs, fct_portfolio, feature_purchases, fee_requeue_log, financial_alerts, financial_health_checks, flash_pool_players, flash_pools, game_action_idempotency_keys, game_formats, game_live_history, game_registry, game_tables, games, gdpr_deletion_requests, geeves_analytics, geeves_answer_ratings, geeves_knowledge_cache, geeves_messages, geeves_missed_questions, grok_explanation_cache, gto_agg_progress, gto_scenarios, hand_audit_decisions, hand_histories, hand_history, hand_history_retention_policy, hendon_scrape_log, horse_brain_telemetry, horse_daily_audit, horse_daily_nets, horse_daily_play, horse_decision_latency, horse_error_log, horse_hand_reviews, horse_job_runs, horse_league_results, horse_mind_pairs, horse_mind_stats, horse_mind_stats_scoped, horse_opponent_reads, horse_post_modes, horse_relationships, horse_review_rollup, horse_self_tune_log, horse_session_analytics, horse_session_stats, horse_solver_agreement, horse_thread_state, horse_threat_intel, horse_tournament_daily, idempotency_keys, insurance_offer_events, insurance_transactions, jarvis_response_cache, kyc_events, leaderboard_entries, leak_review_state, live_game_confirmations, live_games, live_help_analytics, live_help_reactions, lucky_wheel_segments, member_fee_rollup, member_fee_rollup_state, memory_achievement_definitions, memory_charts_gold, memory_daily_challenges, money_flow_checkpoint, news_articles, news_push_log, newsletter_campaigns, notification_prompt_log, orb1_idempotency_keys, orbs, orders, page_claims, pending_calls, pending_fee_distributions, personas, pgrst_reload_watchdog_log, pipeline_runs, platform_policies, player_agent_assignments, player_position_stats, poker_clips, poker_hands, poker_news, poker_reels, poker_venues, poker_videos, post_briefs, posted_clips, posted_sports_clips, poy_leaderboard, privileged_function_lock, probe_heartbeats, promo_code_redemptions, promo_codes, promo_codes_used, promo_distributions, promo_vault_catalog, promo_vault_inventory, promo_vault_records, promo_wagering_ledger, promotion_leaderboards, promotions, purchase_history, push_dispatch_runs, push_outbox, pwa_prompt_log, rabbit_hunt_offers, rabbit_hunt_reveals, rake_attributions, rake_distribution_legs, rake_history, rake_rate_audit, rake_records, rakeback_distributions, rakeback_stats_applied, referral_milestone_claims, referral_redemptions, responsible_gaming_limits, responsible_gaming_sessions, reward_claims, reward_definitions, role_changes, sandbox_results, sandbox_weekly_spots, scrape_evidence, scrape_source_registry, scraper_metrics, scraper_watchdog_state, seed_reveals, seeded_content, settlement_idempotency_keys, settlement_invoices, settlement_journal, settlement_locks, seven_deuce_bounties, share_streak_rewards, signup_abuse_log, signup_errors, signup_errors_archive, slug_history, social_conversation_participants, social_conversations, social_pages_orphan_archive, spin_bonus_pools, spin_payout_ladder, spin_reserve_ledger, spin_unpaid_backpay_log, sports_clips, sso_bridge_tokens, stack_depth_configs, staff_claim_tokens, sticker_assets, stories, sub_agents, system_cache, system_logs, table_activity, table_addon_idempotency, table_cashout_history, table_pending_addons, table_sessions, theme_asset_unlocks, theme_unlocks, toke_entries, topic_cooldowns, tour_event_details, tour_events, tour_schedule_registry, tour_scrape_registry, tour_source_registry, tournament_conservation_baseline, tournament_payout_backfill_log, tournament_place_overpay_charges, tournament_place_renumbers, tournament_players_position_repair_20260901, tournament_rake_settlements, tournament_registrations, tournament_reminders_sent, tournament_results, tournament_schedule_spawns, tournament_schedules, tournament_survivor_rank_backfill, training_achievements, training_challenge_definitions, training_daily_challenges, training_drills, training_levels, training_tournaments, training_user_progress, trivia_category_health, trivia_quality_audits, trivia_regression_runs, union_admins, union_announcements, union_club_terms, union_creators, union_invoice_counters, union_pnl_settlements, union_presettlements, union_rake_ledger_checkpoint, union_rake_paid_daily_user, union_rake_rollup_days, union_rake_weekly, union_rakeback_log, union_settlement_floor, union_settlement_rounds, union_wallets, user_badges, user_bonus_progress, user_daily_rewards, user_daily_streaks, user_diamond_balance, user_diamonds, user_lucky_wheel_spins, user_tos_acceptances, v_backtest_summary, venue_aliases, venue_claims, venue_directory_enrichment_log, venue_duplicate_retirement_log, venue_game_snapshots, venue_live_history, venue_location_integrity_log, venue_location_integrity_state, venue_managers, venue_news, venue_tournament_schedules, video_clips, video_library_videos, villain_archetypes, vip_feature_usage_monthly, vip_plan_switches, vip_points, vip_points_carry, vip_points_ledger, vip_pricing, vip_subscriptions, wallet_audit_backfill_log TO service_role;
GRANT REFERENCES, SELECT, TRIGGER ON TABLE engine_maintenance_break TO anon;
GRANT REFERENCES, SELECT, TRIGGER ON TABLE engine_maintenance_break TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE engine_maintenance_break TO service_role;
GRANT REFERENCES, SELECT, TRIGGER ON TABLE engine_table_leases TO anon;
GRANT REFERENCES, SELECT, TRIGGER ON TABLE engine_table_leases TO authenticated;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE engine_table_leases TO service_role;
GRANT REFERENCES, TRIGGER ON TABLE training_question_cache TO anon;
GRANT REFERENCES, TRIGGER ON TABLE training_question_cache TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE training_question_cache TO service_role;
GRANT SELECT ON TABLE bbj_mini_tiers, commander_home_group_weekly_snapshots, commander_home_invite_tokens, diamond_reward_catalog, merchandise_item_variants, merchandise_items, settlement_periods TO anon;
GRANT SELECT ON TABLE bbj_mini_tiers, commander_home_group_weekly_snapshots, commander_home_invite_tokens, diamond_reward_catalog, merchandise_item_variants, merchandise_items, settlement_periods TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE bbj_mini_tiers, commander_home_group_weekly_snapshots, commander_home_invite_tokens, diamond_reward_catalog, merchandise_item_variants, merchandise_items, settlement_periods TO service_role;
GRANT SELECT ON TABLE rakeback_period_payouts, rakeback_periods TO anon;
GRANT SELECT ON TABLE rakeback_period_payouts, rakeback_periods TO authenticated;
GRANT SELECT ON TABLE rakeback_period_payouts, rakeback_periods TO service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE friendships TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE friendships TO service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE ca_hand_notes, hand_discards, horse_bug_reports, message_reactions, messenger_blocked, user_lobby_filters, user_table_studio_preferences TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE ca_hand_notes, hand_discards, horse_bug_reports, message_reactions, messenger_blocked, user_lobby_filters, user_table_studio_preferences TO service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, TRIGGER ON TABLE profiles TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE profiles TO service_role;
GRANT DELETE, INSERT, MAINTAIN, SELECT, UPDATE ON TABLE bbj_notify_thresholds, training_moves TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE bbj_notify_thresholds, training_moves TO service_role;
GRANT DELETE, MAINTAIN, SELECT, UPDATE ON TABLE leak_hand_examples TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE leak_hand_examples TO service_role;
GRANT INSERT ON TABLE customization_operations TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE customization_operations TO service_role;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE agent_commissions_unsettled, v_agent_commissions, v_spin_unfilled_waits TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE agent_commissions_unsettled, v_agent_commissions, v_spin_unfilled_waits TO service_role;
GRANT MAINTAIN, SELECT ON TABLE ca_hand_facts, cash_game_waitlist, cash_seat_moves, club_message_dismissals, leaderboard_reward_program_versions TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE ca_hand_facts, cash_game_waitlist, cash_seat_moves, club_message_dismissals, leaderboard_reward_program_versions TO service_role;
GRANT REFERENCES, SELECT, TRIGGER ON TABLE ca_bridge_rate, ca_hand_flags, cash_games, club_arena_messages, iap_products, page_notifications, social_message_reads, tournament_place_collisions TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE ca_bridge_rate, ca_hand_flags, cash_games, club_arena_messages, iap_products, page_notifications, social_message_reads, tournament_place_collisions TO service_role;
GRANT SELECT ON TABLE accounting_invoice_deliveries, agent_commission_settlements, agent_commissions, anti_cheat_flags, bbj_threshold_crossings, ca_hand_player_idx, ca_mint_ledger, ca_mint_policy, ca_mint_policy_changes, chip_requests, commander_home_ban_appeals, daily_challenge_dashboard_revisions, diamond_packages, diamond_wallet_transfers, game_management_events, merchandise_orders, pa_coach_feedback, pa_coaching_goals, pa_coaching_preferences, pa_data_lifecycle_receipts, player_stats_snapshots, poker_diamond_custody, poker_diamond_movements, union_eco_ledger TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE accounting_invoice_deliveries, agent_commission_settlements, agent_commissions, anti_cheat_flags, bbj_threshold_crossings, ca_hand_player_idx, ca_mint_ledger, ca_mint_policy, ca_mint_policy_changes, chip_requests, commander_home_ban_appeals, daily_challenge_dashboard_revisions, diamond_packages, diamond_wallet_transfers, game_management_events, merchandise_orders, pa_coach_feedback, pa_coaching_goals, pa_coaching_preferences, pa_data_lifecycle_receipts, player_stats_snapshots, poker_diamond_custody, poker_diamond_movements, union_eco_ledger TO service_role;
GRANT SELECT ON TABLE trivia_pvp_queue TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE trivia_pvp_queue TO service_role;
GRANT SELECT ON TABLE trivia_pvp_matches, trivia_sessions TO authenticated;
GRANT INSERT, SELECT, UPDATE ON TABLE trivia_pvp_matches, trivia_sessions TO service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE agent_commission_unsettled_rollup, auth_health_view, avatar_shop_aliases, avatar_shop_catalog, avatar_style_catalog, bbj_conservation_baseline, bbj_drill_arms, bbj_ledger_deletions, bbj_near_misses, bbj_pool_restorations, bomb_pot_manual_requests, ca_account_snapshots, ca_alarm_drills, ca_arena_settings, ca_bbj_alloc_state, ca_bbj_bucket_moves, ca_bbj_policy, ca_bbj_pool_snapshots, ca_bridge_rate_history, ca_browser_definer_allowlist, ca_cert_accounts, ca_check_sweep_exemptions, ca_club_bomb_pot_complete, ca_club_bomb_pot_daily, ca_club_commission_daily, ca_club_data_export_rows, ca_club_data_exports, ca_club_rake_daily, ca_club_rake_daily_user, ca_collusion_scan_state, ca_collusion_signals, ca_currency_meter, ca_daily_bonus_calendar, ca_daily_bonus_calendar_history, ca_daily_bonus_claims, ca_daily_bonus_days, ca_declared_money_triggers, ca_detector_registry, ca_diamond_balance_audit, ca_diamond_dead_store_writes, ca_diamond_house, ca_diamond_house_ledger, ca_diamond_incidents, ca_diamond_journal_archive, ca_diamond_rule_modes, ca_diamond_snapshots, ca_direct_balance_writes, ca_drift_incidents, ca_dropped_index_ledger, ca_escrow_shadow_results, ca_escrow_shadow_runs, ca_freeroll_free_buy_log, ca_frozen_pool_baseline, ca_frozen_pool_deletions, ca_gate_runs, ca_guard_def_history, ca_guard_defs, ca_guard_inventory, ca_hand_financial_facts, ca_hand_player_idx_state, ca_hand_player_stat, ca_hand_player_stat_state, ca_horse_fleet_heartbeat, ca_horse_fleet_policy, ca_horse_fleet_register, ca_horse_fleet_state, ca_idx_every_seat_state, ca_incident_events, ca_incident_file_failures, ca_incident_notify_ledger, ca_incident_recipients, ca_integrity_case_items, ca_integrity_cases, ca_integrity_sanctions, ca_kill_switch_policy, ca_ledger_accounts, ca_ledger_day_manifest_restatements, ca_ledger_day_manifests, ca_ledger_mutation_log, ca_money_path_enforcement, ca_money_path_violations, ca_money_rpc_registry, ca_noop_update_stats, ca_op_claims, ca_operator_approvals, ca_operator_grants, ca_operator_policy, ca_operator_role_permissions, ca_operator_roles, ca_pending_promo_accruals, ca_profile_deletions, ca_rake_rules, ca_rake_schedule_caps, ca_ratchet_baselines, ca_retired_cron_jobs, ca_seat_guard_dryrun, ca_seat_stack_rebases, ca_settle_sources, ca_settlements, ca_stats_witness_audit_log, ca_supply_breach_ack, ca_supply_snapshot_classifications, ca_supply_snapshots, ca_test_account_audit_archive, ca_tournament_conservation_samples, ca_union_rake_attribution, cash_cluster_epoch, cash_cluster_events, cash_game_roster, cash_player_session, cash_rejoin_constraints, cash_seat_change_requests, cashier_operations, challenge_streak_state, chip_ledger_idem, chip_supply_snapshots, client_crash_log, club_entry_daily_metrics, club_entry_events, club_entry_feature_flags, club_financial_quarantine, club_memberships, club_profit_reconcile_log, club_table_daily, crash_rounds, daily_challenge_catalog_history, daily_challenge_claim_batches, daily_challenge_event_outbox, daily_challenge_freeze_entitlements, daily_challenge_milestone_claims, daily_challenge_milestones, daily_challenge_progress_events, daily_challenge_reroll_receipts, daily_mission_operations, db_saturation_selftest_log, diamond_bonus_spin_tickets, diamond_debts, diamond_engine_daily_caps, diamond_game_commits, diamond_game_config_history, diamond_game_configs, diamond_game_pools, diamond_platform_budget, diamond_purchase_disputes, diamond_purchase_lots, diamond_reward_budgets, diamond_reward_catalog_history, diamond_user_daily_awards, engine_alerts, engine_maintenance_thaws, engine_presence_parked, game_ticker_settings, gto_agg_progress_v31, gto_combo_map, gto_postflop_compact, gto_postflop_v31, hand_history_compaction_policy, hand_state_snapshots, horse_analytics, horse_data_ledger, horse_hand_history, horse_hand_results, horse_memory, horse_opponent_journals, horse_personality, horse_phrase_ledger, horse_source_assignments, horse_sports_source_assignments, horse_style_performance, horse_topic_cooldowns, iap_events, index_usage_snapshots, leak_drill_answers, leak_drill_attempts, leak_drill_sessions, leak_review_operations, live_guest_revocations, managed_game_command_receipts, managed_game_contract_versions, managed_game_schedules, member_fee_lifetime, merchandise_order_events, money_check_heartbeat, mv_hand_histories, operational_alert_events, pa_leak_audit_jobs, phase22_remediation_playbook, phase22_rls_table_audit, phase22_secdef_grant_audit, phase22_view_security_audit, phone_verification_receipts, plinko_drops, plinko_tables, poker_diamond_lot_reservations, poker_diamond_tournament_ledger, rakeback_daily_state, rakeback_daily_user, rate_limits, signup_health_view, solver_manifest, solver_pipeline, sp_combo_class, sp_pending_family_cache, spin_fill_policy, stable_hand_beats, stable_hand_horse_state, stable_hand_membership_tags, stripe_webhook_events, table_settings_changes, theme_preset_aliases, theme_preset_catalog, tournament_bounty_chests, tournament_escrow, tournament_escrow_shadow, training_cache_audit_runs, training_leaderboard_top, training_question_cache_quarantine, trivia_diamond_award_limits_history, trivia_economy_audit_runs, trivia_question_reports, union_rake_basis_snapshot, v_bomb_pot_daily, v_bomb_pot_outcomes, v_bomb_pot_vs_normal, v_ca_alert_board, v_cashier_failures_daily, v_cashier_health_hourly, v_chip_ledger, v_customization_health_daily, v_customization_health_hourly, v_daily_challenge_event_outbox_health, v_daily_mission_health_daily, v_daily_mission_health_hourly, v_shell_reload_lateness, v_shell_staleness_rate, v_spin_draw_booking_gaps, v_spin_draw_fairness, v_spin_reserve_health, v_spin_reveal_latency, v_spin_unpaid_settlements, v_tournament_rake_attribution_gaps, video_library_public_catalog, video_reels_pipeline_config, video_reels_pipeline_controls, video_transcode_jobs, vip_diamond_purchase_requests, vip_lifetime_purchases, vip_subscription_checkout_claims, waitlist_policy, wheel_config_history, wheel_configs, wheel_pools, wheel_seed_commits, wheel_segment_versions, wheel_segments, wheel_spins, youtube_embed_failures TO service_role;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE training_question_snapshots TO service_role;
GRANT INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE ON TABLE lightning_hand, lightning_hand_player, lightning_instance, lightning_pool_session, lightning_pool_slot, lightning_reservation TO service_role;
GRANT INSERT, SELECT ON TABLE digital_purchase_receipts, throwable_use_receipts, training_daily_question_seals TO service_role;
GRANT INSERT, SELECT, UPDATE ON TABLE trivia_tournament_entries, trivia_tournament_rounds, trivia_tournaments TO service_role;
GRANT MAINTAIN, REFERENCES, SELECT, TRIGGER ON TABLE ca_manual_adjustments, ca_payout_freeze, training_daily_challenge, training_questions, training_streak_milestone_claims, training_verified_leaderboard TO service_role;
GRANT MAINTAIN, SELECT ON TABLE tournament_bounty_award_recipients, tournament_bounty_awards TO service_role;
GRANT SELECT ON TABLE accepted_event_operations, accounting_mixed_cutover_spin_fee_proofs, accounting_tournament_fee_batches, accounting_tournament_fee_cutover, accounting_tournament_fee_owner_bases, accounting_tournament_fee_owner_operations, accounting_tournament_fee_recognitions, accounting_tournament_fee_sources, accounting_tournament_recognized_sources, ca_diamond_engine_spend, ca_engine_deploy_attempts, ca_epoch_closing_positions, cash_participant_funding_receipts, competitive_quarantine, hand_atomic_commits, hand_projection_outbox, operational_notification_destinations, platform_capabilities, poker_diamond_hand_receipts, poker_diamond_spin_contracts, poker_diamond_spin_reserve_source, solved_spots_gold, solver_status, spin_draw_receipts, tournament_accounting_credit_receipts, tournament_bounty_completion_receipts, tournament_bounty_obligations, tournament_felt_supply_acknowledgements, tournament_final_table_deal_batches, tournament_final_table_deal_receipts, tournament_finish_receipts, tournament_guarantee_overlays, tournament_knockout_candidates, tournament_manager_wakes, tournament_mystery_activation_receipts, tournament_obligation_events, tournament_obligations, tournament_participant_funding_receipts, tournament_pko_settlement_watermarks, tournament_place_settlement_batches, tournament_refund_entitlements, tournament_satellite_economic_snapshots, tournament_satellite_entitlements, tournament_satellite_settlement_batches, tournament_stage_plans, tournament_stage_resume_receipts, tournament_stages, training_attempt_decision_slots, training_daily_question_conflicts, training_question_events, training_solver_artifact_catalog, trivia_pvp_active_seats, trivia_pvp_session_links, trivia_pvp_settlement_decisions, trivia_tournaments_public, union_pnl_credit_touches, union_pnl_inventory_touches, video_reels_legacy_transition_rows, video_reels_legacy_transition_state TO service_role;

-- ============================================================================
-- Every table above, read back out of the catalogue: its columns, defaults,
-- constraints, indexes, triggers (with their enabled state) and row-security
-- flags must render to exactly the signature production rendered when this
-- file was generated. One character of difference and the load stops.
-- Parentheses are the one thing the signature leaves out: PostgreSQL stores a
-- BETWEEN or a ROW(...) IS DISTINCT FROM as a nested expression and renders it
-- with its own brackets, and the same text read back in is stored flattened.
-- The words, operators and literals are production's to the character.
-- ============================================================================
DO $shape$
DECLARE r record; v_sig text; v_seen integer := 0; v_bad integer := 0;
BEGIN
  -- Render exactly as production's catalogue was read: its default search path
  -- (pg_catalog first, then public, then extensions) and UTC.
  PERFORM set_config('search_path', '"$user", public, extensions', true);
  PERFORM set_config('TimeZone', 'UTC', true);
  FOR r IN SELECT * FROM (VALUES
    ('public.accounting_invoice_deliveries','24287174b91b926d97148537ef5be4b2'),
    ('public.accounting_mixed_cutover_spin_fee_proofs','6f45fca75d9e612d9497614e01146b43'),
    ('public.accounting_tournament_fee_batches','92434bd1266367e300079d4c9e09102e'),
    ('public.accounting_tournament_fee_custody_obligations','4e630dd1dc4aa2a6d966dd3e431e0633'),
    ('public.accounting_tournament_fee_custody_resolutions','60e9e594054055bfab337c2badeb5115'),
    ('public.accounting_tournament_fee_cutover','87875293fc2128817608dda70b8f24ba'),
    ('public.accounting_tournament_fee_owner_bases','a0be4f6c803c2a35aea2ced8232dc752'),
    ('public.accounting_tournament_fee_owner_operations','c883907618540ff0cd01907ab44bb49f'),
    ('public.accounting_tournament_fee_recognitions','c9ea7ac4e76a226aaba3aee2c47bd3ab'),
    ('public.accounting_tournament_fee_sources','05c83ba678ad7dd36055abffd654e36f'),
    ('public.accounting_tournament_recognized_sources','bed2e2b65997b4ad259a94121ae27809'),
    ('public.ca_diamond_balance_audit','b9dfb786afa1a3efe4402004c5d58a1a'),
    ('public.ca_diamond_house','6badda8dbe7e04bb0b749d34bc47d463'),
    ('public.ca_ledger_maintenance_kinds','ed89a3ef49a011d55f1962792f76c775'),
    ('public.ca_mint_ledger','8a3582d320e74d9040e7c1c80e108e69'),
    ('public.cash_cluster_epoch','ce1c12650e2e54df8271a8ac205b65a3'),
    ('public.cash_games','a0ad08978105312da1b65f8c08be964a'),
    ('public.cash_participant_funding_receipts','5f1fa8c016b661f90e5a5d6276f270bc'),
    ('public.clubs','42da585160d9fd90c01b6720d0233826'),
    ('public.daily_challenge_dashboard_revisions','64b3941bfd99789fdb25801f22130da4'),
    ('public.daily_challenge_event_outbox','ecf659c0f34d1d7356fecf8d0eac5297'),
    ('public.daily_challenge_progress_events','843f45458d52634207b24df0e5ccd9a8'),
    ('public.diamond_bonus_spin_tickets','4d59eb688dd1d3894fbb98a29dbb2604'),
    ('public.diamond_debts','461acff1ba933a591fe4c1006fb756c2'),
    ('public.diamond_purchase_lots','bf2b6a637a4ecf6472996c1dedfe965a'),
    ('public.diamond_spin_days','cebd3ad5f948ab549a2d663fad884efd'),
    ('public.diamond_spin_movements','a8ac58b8dffbcf3985250d283225cd16'),
    ('public.diamond_transactions','e753c769544875644a6483d8da208717'),
    ('public.diamond_wallet_transfers','9c44311209294a5a14dcde0dc487e907'),
    ('public.diamond_wallets','7f7e7389ad63c16fa1c53b1f0f41fa00'),
    ('public.digital_purchase_receipts','5c868e4d9f2e6d43cacca92c49a93141'),
    ('public.entry_purchase_idempotency_receipts','89eb1ec44408fe4df818cf012dd78e9f'),
    ('public.feature_pricing','1d82e47f94b05beb919616fbfaf69fb7'),
    ('public.feature_purchases','461ece04678ebe8f94adaa80ad1f039a'),
    ('public.friendships','40c69ca90622fa1ea0649179f59a61a2'),
    ('public.game_management_events','4a4e5ee25912cc89da5a5e730ddb4518'),
    ('public.lightning_hand','98cf883d80256a6d47d10b3284427c4c'),
    ('public.lightning_hand_player','99757ada8575d93381abdaa39a8ea466'),
    ('public.lightning_instance','edd0ca826c2dfe31e2022a787d6dafc7'),
    ('public.lightning_pool_session','77262959635df67d936b0a461a1cd9ea'),
    ('public.lightning_pool_slot','f168360d5f6f0dde3c7cfc64815248bc'),
    ('public.lightning_reservation','418384143b7cc683c923b0aab0034b84'),
    ('public.notifications','b5d033a7127bba1b286de6496308a2f6'),
    ('public.operational_alert_events','977d4cd6a45eb1a845822f781d463895'),
    ('public.operational_notification_destinations','c1aacb25f4675c6d5793649f808c6ec6'),
    ('public.poker_diamond_custody','656214edc5279e2bbb9f8feb56fcaabd'),
    ('public.poker_diamond_lot_reservations','36b449ef1bb45a20a6a4ef6fcbd92533'),
    ('public.poker_diamond_movements','609f2387bd5e25300392e88e1d09c81f'),
    ('public.poker_diamond_tournament_ledger','c8285ceee32ac85d800d6cadbcc1a44d'),
    ('public.profiles','3b2cbc66a62cec9a50940536b896c4ee'),
    ('public.seat_admin_departure_authorizations','96b391ec1175b1fe78b8cb1b5541dde8'),
    ('public.seat_cashout_receipts','67684d41af891957b2b50739fbcf4106'),
    ('public.seat_departure_requests','4d1c3ada211142afe85d190955d0bebf'),
    ('public.table_seats','e086ae804bd03521ac5a56678e383d8a'),
    ('public.table_waitlist','aaae30ff60796cf8abba2739167d1d77'),
    ('public.tables','a69a812397c178d19bd61b5dce3b9be5'),
    ('public.tournament_accounting_credit_receipts','83efcdae3aafefae16f7f093b367c8fa'),
    ('public.tournament_escrow','5b7772b3a0c51004467c8ba047f08331'),
    ('public.tournament_felt_supply_acknowledgements','902d5763200742c7d743f8c6ac98c4c4'),
    ('public.tournament_obligation_events','ab5b84432a80eb28c5439834ef0e82c8'),
    ('public.tournament_obligations','c770bbbdc985e43da108242741a24fe1'),
    ('public.tournament_paid_stack_custody_receipts','d4cf84c61a27511bb903e1afab3e65c2'),
    ('public.tournament_participant_funding_receipts','32a9dcbfa95bf989206ee471d55190d2'),
    ('public.tournament_players','5de2bdd5d4d81b51a5cbbc25b38bcdef'),
    ('public.tournament_stage_plans','a3dd8f9741cafe84bd08eb17f9fb25ff'),
    ('public.tournament_stage_resume_receipts','63af74a2b4a43cb603cceef33a4862ad'),
    ('public.tournament_stages','54086ea2743d5ce47458fbdf45c296d2'),
    ('public.tournaments','bcba27e4b1be0b65086c5a8b84675fd8'),
    ('public.union_pnl_credit_touches','5218ab1715f37f2857c6a51b9b38d29a'),
    ('public.union_pnl_inventory_events','99df59585bafe260fad5af624fe2ec70'),
    ('public.union_pnl_inventory_touches','dde2e311af62ed37672dec16c60f411b'),
    ('public.union_pnl_transaction_frames','0262b334dae3f9a4950b8b9a1f29fd62'),
    ('public.user_diamond_balance','b1b63908bfa5d535654aad2601fbbcd5'),
    ('public.user_diamonds','4c80effad08ccd961616e81b5ffd23d1'),
    ('public.wallet_credit_idempotency','15b0fe16bfc770a5a4795ce97bd56033'),
    ('smarter_private.breakfast_original_witness','faed512d8afefecb74756ca6c9b20bea'),
    ('smarter_private.f06_attempts','e3096b009c767a000f092c181536d6fe'),
    ('smarter_private.f06_dispatch','d18bd4f771d2d56f8facb28dc409cc53'),
    ('smarter_private.f06_elimination_dispatch','7017d59e87442da27c7be0dcebf28dea'),
    ('smarter_private.f06_generation_abort_hands','46c225ed6d367968df5a154fc36af9ee'),
    ('smarter_private.f06_generation_aborts','df62dfb7f588ab3832f5973e97ebdf7a'),
    ('smarter_private.f06_hand_dispatch','a58e639664758331693ea099ea726b9d'),
    ('smarter_private.f06_hand_permits','e8983ed4f5a9a84757c1dc72760dbf23'),
    ('smarter_private.f06_manager_custody_admissions','df1495dd55a8fab55d4ac1a9e2323d7d'),
    ('smarter_private.f06_manager_custody_completions','f182c5c872c61e1628f38d56fdee9c64'),
    ('smarter_private.f06_manager_custody_transfers','a7f3edc84bfad1d9b48265b2749dea60'),
    ('smarter_private.f06_members','3ab646c0c37592133f6a6ddd75865b9c'),
    ('smarter_private.f06_mixed_abort_generations','d9c6a80a9c5f86290c60d4553dbc9b71'),
    ('smarter_private.f06_mixed_abort_hands','5bcaf4500db051ab964163bb5ec8c537'),
    ('smarter_private.f06_mixed_aborts','ff1839fa0afd39e5aaf8b877e5fb1431'),
    ('smarter_private.f06_movement_admissions','5476a8c195e4dc81bcc858aeea6fe51f'),
    ('smarter_private.f06_no_start_continuations','a93044d198ff1c3127985c8d7ad2cc5a'),
    ('smarter_private.f06_operations','e962b3b9425be43e2d89adf1880c3c89'),
    ('smarter_private.f06_unsettled_hand_aborts','76ee0bff39851cae08471970bacc7888'),
    ('smarter_private.hand_submission_dispositions','9db9a8fe0ebf284912aaa84fffe715ef'),
    ('smarter_private.spin_archived_first_admission','1842b242fa98921dc15e218f0780c0dd'),
    ('smarter_private.spin_original_standings','271d7fddbf4f7599f4a3f0c3d3ea4903')
  ) AS t(tab, want)
  LOOP
    v_seen := v_seen + 1;
    SELECT md5(string_agg(translate(line, '()', ''), E'\n' ORDER BY translate(line, '()', '') COLLATE "C")) INTO v_sig FROM (
      SELECT 'COL '||a.attname||' '||format_type(a.atttypid,a.atttypmod)
             ||CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
             ||COALESCE(' DEFAULT '||regexp_replace(pg_get_expr(d.adbin,d.adrelid),'\m(public|extensions)\.','','g'),'')
             ||CASE WHEN a.attidentity::text<>'' THEN ' IDENTITY '||a.attidentity::text ELSE '' END
             ||CASE WHEN a.attgenerated::text<>'' THEN ' GENERATED '||a.attgenerated::text ELSE '' END AS line
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE a.attrelid=r.tab::regclass AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'CON '||k.conname||' '||regexp_replace(pg_get_constraintdef(k.oid),'\m(public|extensions)\.','','g')
             ||CASE WHEN k.condeferrable THEN ' DEFERRABLE' ELSE '' END
             ||CASE WHEN k.condeferred THEN ' INITIALLY DEFERRED' ELSE '' END
        FROM pg_constraint k WHERE k.conrelid=r.tab::regclass AND k.contype<>'t'
      UNION ALL
      SELECT 'IDX '||i.relname||' '||regexp_replace(pg_get_indexdef(i.oid),'\m(public|extensions)\.','','g')
        FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=r.tab::regclass
      UNION ALL
      SELECT 'TRG '||t.tgname||' '||regexp_replace(pg_get_triggerdef(t.oid),'\m(public|extensions)\.','','g')||' '||t.tgenabled::text
        FROM pg_trigger t WHERE t.tgrelid=r.tab::regclass AND NOT t.tgisinternal
      UNION ALL
      SELECT 'REL rls='||CASE WHEN c.relrowsecurity THEN 'True' ELSE 'False' END
             ||' force='||CASE WHEN c.relforcerowsecurity THEN 'True' ELSE 'False' END
        FROM pg_class c WHERE c.oid=r.tab::regclass
    ) s;
    IF v_sig IS DISTINCT FROM r.want THEN
      RAISE WARNING '% renders to shape % but production''s is %', r.tab, v_sig, r.want;
      v_bad := v_bad + 1;
    END IF;
  END LOOP;
  IF v_seen <> 97 THEN
    RAISE EXCEPTION 'this file declares 97 production table shapes but checked %', v_seen;
  END IF;
  IF to_regprocedure('public.add_diamonds_to_balance(uuid,integer,text,text,text)') IS NOT NULL THEN RAISE EXCEPTION 'a stale overload survived: public.add_diamonds_to_balance'; END IF;
  IF to_regprocedure('public.fn_raise_server_financial_alert(text,text,text,jsonb,text)') IS NOT NULL THEN RAISE EXCEPTION 'a stale overload survived: public.fn_raise_server_financial_alert'; END IF;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% of % tables do not have production''s shape', v_bad, v_seen;
  END IF;
  RAISE NOTICE 'PASS: all % tables the money doors write have production''s exact shape: columns, constraints, indexes and triggers', v_seen;
END $shape$;
