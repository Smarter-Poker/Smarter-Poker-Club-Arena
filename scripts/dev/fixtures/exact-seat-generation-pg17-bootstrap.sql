\set ON_ERROR_STOP on

CREATE SCHEMA realtime;
CREATE TABLE realtime.subscription (
  id bigint PRIMARY KEY
);

/* This supplements post-commit-obligations-pg17-bootstrap.sql.  Keep the
   shared fixture small and install only the relations reached by the real
   seven-argument stack settlement during these adversarial cases. */
ALTER TABLE public.table_seats
  ADD COLUMN joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN club_id uuid;

CREATE TABLE public.settlement_idempotency_keys (
  table_id uuid NOT NULL,
  hand_id uuid NOT NULL,
  status text NOT NULL,
  result jsonb,
  error text,
  attempt_count integer NOT NULL,
  first_attempt_at timestamptz NOT NULL,
  last_attempt_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (table_id, hand_id)
);

CREATE TABLE public.ca_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_type text NOT NULL,
  external_ref text NOT NULL,
  state text NOT NULL,
  table_id uuid,
  hand_id uuid,
  idempotency_key text,
  error_detail text,
  totals jsonb,
  UNIQUE (settlement_type, external_ref)
);

CREATE TABLE public.ca_seat_stack_rebases (
  settlement_id uuid,
  table_id uuid,
  hand_id uuid,
  hand_number bigint,
  user_id uuid,
  engine_before numeric,
  db_before numeric,
  engine_after numeric,
  written numeric
);

CREATE TABLE public.wallet_credit_idempotency (
  key text PRIMARY KEY,
  user_id uuid NOT NULL,
  amount numeric NOT NULL
);

CREATE TABLE public.club_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  club_id uuid NOT NULL,
  chip_balance numeric NOT NULL DEFAULT 0,
  updated_at timestamptz,
  UNIQUE (user_id, club_id)
);

CREATE TABLE public.chip_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  to_user_id uuid,
  amount numeric,
  transaction_type text,
  notes text,
  table_id uuid,
  balance_after numeric,
  metadata jsonb
);

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  starting_chips numeric,
  rebuy_chips numeric,
  addon_chips numeric
);

CREATE TABLE public.wallet_transactions (
  user_id uuid,
  category text,
  type text,
  related_entity_id uuid,
  created_at timestamptz
);

CREATE OR REPLACE FUNCTION public.fn_ca_declare_ledger(
  p_category text,
  p_counterparty text,
  p_counterparty_entity uuid DEFAULT NULL,
  p_settlement_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_balance_columns text[] DEFAULT NULL
) RETURNS void
LANGUAGE sql
AS $function$
  SELECT;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_raise_drift_incident(
  p_source text,
  p_classification text,
  p_severity text,
  p_dedupe_key text,
  p_discrepancy numeric,
  p_expected numeric DEFAULT NULL,
  p_actual numeric DEFAULT NULL,
  p_layer text DEFAULT 'unknown',
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_club_id uuid DEFAULT NULL,
  p_union_id uuid DEFAULT NULL,
  p_table_id uuid DEFAULT NULL,
  p_tournament_id uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL,
  p_settlement_id text DEFAULT NULL,
  p_wallet_ids uuid[] DEFAULT NULL,
  p_transaction_ids uuid[] DEFAULT NULL,
  p_suspected_cause text DEFAULT NULL,
  p_ledger_balanced boolean DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'
) RETURNS uuid
LANGUAGE sql
AS $function$
  SELECT NULL::uuid;
$function$;

/* The zero-delta migration contains two unrelated definitions/comments.  Tiny
   fixtures let the real migration run, instead of copying its settlement text
   substitution into this harness. */
CREATE TABLE public.training_answers (
  user_id uuid,
  is_correct boolean,
  ev_loss numeric,
  level integer
);

CREATE OR REPLACE FUNCTION public.fn_ca_currency_meter()
RETURNS integer
LANGUAGE sql
AS $function$
  SELECT 1;
$function$;
