CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.hand_projection_outbox (
  hand_id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.hand_atomic_commits (
  hand_id uuid PRIMARY KEY,
  hand_number bigint NOT NULL UNIQUE,
  post_commit_payload jsonb,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.ca_hand_fact_projection_receipts (
  hand_id uuid PRIMARY KEY,
  source_hash text NOT NULL,
  fact_count integer NOT NULL,
  transfer_count integer NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.ca_hand_fact_reconcile_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cursor_hand_number bigint NOT NULL DEFAULT 0,
  rows_checked bigint NOT NULL DEFAULT 0,
  rows_repaired bigint NOT NULL DEFAULT 0,
  unavailable bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.ca_reconcile_missing_hand_facts(integer)
RETURNS jsonb
LANGUAGE sql
AS $$ SELECT '{"ok":true}'::jsonb $$;

CREATE TABLE public.ca_hand_fact_revisions (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
