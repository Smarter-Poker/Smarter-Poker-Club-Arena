-- Fixture-only alias for constructing a genuinely pre-repair pending snapshot.
DO $$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure);
 EXECUTE replace(d,'FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(',
                  'FUNCTION public.fixture_claim_pre_r37(');
END $$;
