-- Proposal only. Reserved version 20260910053719. Not applied or registered.
-- Stage 1: additive schema. No historical row updates or balance movement.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE public.agent_commissions ADD COLUMN contributing_user_id uuid;
CREATE TABLE public.ca_commission_contributor_receipts (
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  contributing_user_id uuid NOT NULL,
  requested_club_id uuid NOT NULL,
  booked_club_id uuid,
  rake_credit numeric NOT NULL CHECK (rake_credit >= 0 AND rake_credit NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND rake_credit = round(rake_credit,2)),
  state text NOT NULL CHECK (state IN ('pending','applied','legacy_preserved')),
  allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_type,source_id,contributing_user_id)
);
ALTER TABLE public.ca_commission_contributor_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commission_contributor_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE ON public.ca_commission_contributor_receipts TO service_role;
COMMIT;
