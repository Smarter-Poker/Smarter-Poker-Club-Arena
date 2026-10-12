-- Minimal schema for the claim_tournament_lease_v2 behaviour gate. Only the
-- relations and the one helper the function body reads; shapes and keys match
-- production (checked 2026-09-28). f06_generation_aborted is a named test
-- double driven by harness_aborted.
\set ON_ERROR_STOP on
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA smarter_private;

CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  lease_generation uuid,
  protocol_version integer NOT NULL DEFAULT 2
);

CREATE TABLE smarter_private.f06_manager_custody_transfers (
  transfer_id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL,
  origin_generation uuid NOT NULL,
  successor_generation uuid NOT NULL,
  local_proof jsonb NOT NULL DEFAULT '{}'::jsonb,
  canonical_proof jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, origin_generation),
  UNIQUE (tournament_id, successor_generation)
);

CREATE TABLE smarter_private.f06_manager_custody_completions (
  transfer_id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL,
  generation uuid NOT NULL,
  admission jsonb,
  operation_receipts jsonb,
  presence_receipts jsonb,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE smarter_private.harness_aborted (tournament_id uuid, generation uuid);

-- TEST DOUBLE: production reads the F06 abort receipts.
CREATE FUNCTION smarter_private.f06_generation_aborted(t uuid, g uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM smarter_private.harness_aborted a
                  WHERE a.tournament_id = t AND a.generation = g)
$$;
