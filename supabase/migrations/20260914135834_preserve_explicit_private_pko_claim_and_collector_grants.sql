-- Preserve the already-private R37 callers with explicit migration grants.
-- CREATE OR REPLACE preserved these exact ACLs; the source gate also requires
-- explicit REVOKEs in the change set. This neither adds authority nor rewrites
-- the immutable R37 migration. Unknown source or privileges abort atomically.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $preflight$
DECLARE item jsonb;p record;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements($manifest$[{"signature":"public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)","body":"eb4fa0f4d743202037950334f0b99f83","acl":"{postgres=X/postgres}"},{"signature":"public.fn_collect_bounty(uuid,uuid,uuid,jsonb)","body":"bc621ffbddfd931897706f6d1f099109","acl":"{postgres=X/postgres,service_role=X/postgres}"}]$manifest$::jsonb) LOOP
  SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner
   WHERE f.oid=to_regprocedure(item->>'signature');
  IF NOT FOUND OR md5(p.prosrc)<>item->>'body' OR p.owner<>'postgres'
     OR p.proacl::text IS DISTINCT FROM item->>'acl'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'v' THEN
   RAISE EXCEPTION 'PKO explicit privilege contract source or metadata mismatch: %',item->>'signature';
  END IF;
 END LOOP;
END $preflight$;

REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(
 uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
 FROM PUBLIC,anon,authenticated;
DO $postflight$
DECLARE item jsonb;p record;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements($manifest$[{"signature":"public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)","body":"eb4fa0f4d743202037950334f0b99f83","acl":"{postgres=X/postgres}"},{"signature":"public.fn_collect_bounty(uuid,uuid,uuid,jsonb)","body":"bc621ffbddfd931897706f6d1f099109","acl":"{postgres=X/postgres,service_role=X/postgres}"}]$manifest$::jsonb) LOOP
  SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner
   WHERE f.oid=to_regprocedure(item->>'signature');
  IF NOT FOUND OR md5(p.prosrc)<>item->>'body' OR p.owner<>'postgres'
     OR p.proacl::text IS DISTINCT FROM item->>'acl'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'v' THEN
   RAISE EXCEPTION 'PKO explicit privilege contract source or metadata mismatch: %',item->>'signature';
  END IF;
 END LOOP;
END $postflight$;
COMMIT;
