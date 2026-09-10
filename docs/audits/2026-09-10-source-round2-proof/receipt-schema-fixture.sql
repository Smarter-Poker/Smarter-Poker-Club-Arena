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
REVOKE ALL ON public.ca_commission_contributor_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_commission_contributor_receipts TO service_role;

CREATE TABLE public.hand_atomic_commits(hand_id uuid PRIMARY KEY,post_commit_payload_hash text NOT NULL,commission_capture_version integer CHECK(commission_capture_version=1));
