\set ON_ERROR_STOP on

CREATE TABLE public.engine_maintenance_break (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  phase text NOT NULL,
  announced_at timestamptz NOT NULL DEFAULT now(),
  break_started_at timestamptz,
  break_ends_at timestamptz,
  reason text NOT NULL DEFAULT 'Scheduled Engine Maintenance',
  declared_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  enforce_freeze boolean NOT NULL DEFAULT false,
  ownership_token uuid NOT NULL,
  CHECK (phase IN ('last_hand', 'counting_down')),
  CHECK (phase <> 'counting_down' OR break_ends_at IS NOT NULL)
);

-- Minimal structural inputs used by the captured release-certificate reader.
-- All rows in this database are synthetic; the script starts its own cluster.
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $role$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '');
$role$;
CREATE TABLE public.engine_maintenance_thaws (
  contract_version integer,
  release_target_at timestamptz,
  shifted jsonb NOT NULL
);
