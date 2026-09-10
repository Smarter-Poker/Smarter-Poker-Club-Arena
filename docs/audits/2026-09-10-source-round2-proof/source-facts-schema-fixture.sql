-- PROPOSAL ONLY. Prospective immutable cash commission authority; no backfill.
BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='10s';
CREATE TABLE public.ca_cash_commission_authority (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 contract_version integer NOT NULL CHECK(contract_version=1),
 activated_at timestamptz NOT NULL, accepted_owner_before_md5 text NOT NULL,
 accepted_owner_after_md5 text NOT NULL
);
ALTER TABLE public.ca_cash_commission_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_cash_commission_authority FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_cash_commission_authority TO service_role;
CREATE TABLE public.ca_cash_commission_sources (
 hand_id uuid PRIMARY KEY, table_id uuid NOT NULL, hand_number bigint NOT NULL,
 requested_club_id uuid NOT NULL, accepted_payload_hash text NOT NULL,
 rake_total numeric NOT NULL CHECK(rake_total>=0 AND rake_total=round(rake_total,2)
   AND rake_total::text NOT IN ('NaN','Infinity','-Infinity')),
 rake_method text NOT NULL, contributions jsonb NOT NULL, returned_uncalled jsonb NOT NULL,
 contributor_count integer NOT NULL CHECK(contributor_count>=0),
 accepted_at timestamptz NOT NULL, settled_at timestamptz NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.ca_cash_commission_facts (
 hand_id uuid NOT NULL REFERENCES public.ca_cash_commission_sources(hand_id),
 player_id uuid NOT NULL, booked_club_id uuid, seat_id uuid, seat_joined_at timestamptz,
 rake_credit numeric NOT NULL CHECK(rake_credit>=0 AND rake_credit=round(rake_credit,2)
   AND rake_credit::text NOT IN ('NaN','Infinity','-Infinity')),
 direct_agent_id uuid, payer_user_id uuid,
 assignment_state text NOT NULL CHECK(assignment_state IN
   ('assigned','self_agent','unassigned','assigned_invalid','membership_unavailable','seat_unavailable')),
 direct_commission_rate numeric, player_rebate_rate numeric, player_rebate_entitlement numeric,
 player_terms jsonb NOT NULL, hierarchy jsonb NOT NULL, errors jsonb NOT NULL,
 PRIMARY KEY(hand_id,player_id)
);
ALTER TABLE public.ca_cash_commission_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_cash_commission_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_cash_commission_sources,public.ca_cash_commission_facts
 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_cash_commission_sources,public.ca_cash_commission_facts TO service_role;
CREATE FUNCTION public.fn_ca_cash_commission_facts_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN RAISE EXCEPTION 'Accepted commission source facts are immutable'; END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_cash_commission_facts_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER cash_commission_source_immutable BEFORE UPDATE OR DELETE
 ON public.ca_cash_commission_sources FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_commission_facts_immutable();
CREATE TRIGGER cash_commission_fact_immutable BEFORE UPDATE OR DELETE
 ON public.ca_cash_commission_facts FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_commission_facts_immutable();
CREATE TRIGGER cash_commission_source_no_truncate BEFORE TRUNCATE
 ON public.ca_cash_commission_sources FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_cash_commission_facts_immutable();
CREATE TRIGGER cash_commission_fact_no_truncate BEFORE TRUNCATE
 ON public.ca_cash_commission_facts FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_cash_commission_facts_immutable();
CREATE TRIGGER cash_commission_authority_immutable BEFORE UPDATE OR DELETE
 ON public.ca_cash_commission_authority FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_commission_facts_immutable();
CREATE TRIGGER cash_commission_authority_no_truncate BEFORE TRUNCATE
 ON public.ca_cash_commission_authority FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_cash_commission_facts_immutable();
COMMIT;
