\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth;
CREATE SCHEMA extensions;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$ SELECT NULL::uuid $$;

CREATE OR REPLACE FUNCTION extensions.digest(p_value bytea, p_algorithm text)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF lower(p_algorithm) <> 'sha256' THEN
    RAISE EXCEPTION 'unsupported probe digest %', p_algorithm;
  END IF;
  RETURN sha256(p_value);
END;
$$;

CREATE TABLE public.table_pending_addons (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount numeric,
  kind text,
  created_at timestamptz,
  resolved_at timestamptz,
  applied_to_stack numeric,
  refunded numeric
);

CREATE TABLE public.table_addon_idempotency (
  key text PRIMARY KEY,
  amount numeric
);

CREATE TABLE public.table_seats (
  table_id uuid NOT NULL,
  user_id uuid NOT NULL,
  seat_number integer,
  stack numeric,
  left_at timestamptz
);

CREATE TABLE public.hand_atomic_commits (
  hand_id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  post_commit_payload jsonb,
  post_commit_payload_hash text,
  post_commit_completed_at timestamptz,
  post_commit_result jsonb
);

CREATE TABLE public.probe_receipt_claims (
  door text NOT NULL,
  key text,
  request jsonb NOT NULL
);

CREATE OR REPLACE FUNCTION public.fn_claim_entry_purchase_receipt(
  p_door text,
  p_key text,
  p_request jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.probe_receipt_claims(door, key, request)
  VALUES (p_door, p_key, p_request);
  RETURN jsonb_build_object(
    'claimed', false,
    'response', jsonb_build_object('balance', 123)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_caller_session_is_live()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$ SELECT true $$;

CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$ SELECT true $$;

-- All of these rows predate both constraints. They prove that NOT VALID keeps
-- settled evidence byte-for-byte, including values a new write must reject.
INSERT INTO public.table_pending_addons(
  id, table_id, user_id, amount, kind, created_at, resolved_at,
  applied_to_stack, refunded
) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    16.670000000000002, 'historic', now(), now(), 16.67, 0
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    16.67, 'historic', now(), now(), 16.669, 0.001
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000003',
    16.67, 'historic', now(), now(), 'NaN'::numeric, 0
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000004',
    '30000000-0000-4000-8000-000000000004',
    16.67, 'historic', now(), now(), 0, 'Infinity'::numeric
  ),
  (
    '10000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000005',
    '30000000-0000-4000-8000-000000000005',
    16.67, 'historic', now(), now(), 10, 6.66
  );

INSERT INTO public.table_addon_idempotency(key, amount) VALUES
  ('historic:dust', 16.670000000000002),
  ('historic:nan', 'NaN'::numeric);

CREATE TABLE public.probe_historical_snapshot AS
SELECT
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', id,
        'table_id', table_id,
        'user_id', user_id,
        'amount', amount::text,
        'kind', kind,
        'created_at', created_at,
        'resolved_at', resolved_at,
        'applied_to_stack', applied_to_stack::text,
        'refunded', refunded::text
      ) ORDER BY id
    )
      FROM public.table_pending_addons
     WHERE kind = 'historic'
  ) AS pending,
  (
    SELECT jsonb_agg(
      jsonb_build_object('key', key, 'amount', amount::text)
      ORDER BY key
    )
      FROM public.table_addon_idempotency
     WHERE key LIKE 'historic:%'
  ) AS idempotency;
