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
