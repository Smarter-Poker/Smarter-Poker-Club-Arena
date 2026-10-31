-- Identical Daily Mission row UPDATEs do not change the dashboard.
-- The trusted progress API accepts a zero increment. Previously its identical
-- UPDATE still wrote a revision and sent a paid private broadcast. Keep every
-- genuine change, completion toast, insert/delete and source authority intact.
-- This does not disable paid Realtime or change any reward or retention rule.
-- @live-proof: (SELECT position('IF TG_OP=''UPDATE'' AND OLD IS NOT DISTINCT FROM NEW THEN' IN pg_get_functiondef('public.bump_daily_challenge_dashboard_revision()'::regprocedure))>0)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $install$
DECLARE
 target oid:='public.bump_daily_challenge_dashboard_revision()'::regprocedure;
 original text; patched text; metadata jsonb; actual jsonb;
 anchor constant text:=E'BEGIN\n  IF TG_TABLE_NAME = ''profiles'' THEN';
BEGIN
 SELECT pg_get_functiondef(p.oid),jsonb_build_object('owner',p.proowner,'acl',p.proacl,
  'security_definer',p.prosecdef,'settings',p.proconfig) INTO original,metadata
 FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF md5(original) IS DISTINCT FROM '367863ecd73d5909ba2ed8701ba8b168'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=target
  AND p.proowner='postgres'::regrole AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
  AND p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_temp'])
 OR (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'DAILY_REVISION_NOOP_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 patched:=replace(original,anchor,E'BEGIN\n  -- No input changed: preserve the cursor and avoid a paid source send.\n  IF TG_OP=''UPDATE'' AND OLD IS NOT DISTINCT FROM NEW THEN\n    RETURN NEW;\n  END IF;\n  IF TG_TABLE_NAME = ''profiles'' THEN');
 EXECUTE patched;
 SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,
  'security_definer',p.prosecdef,'settings',p.proconfig) INTO actual
 FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF actual IS DISTINCT FROM metadata OR pg_get_functiondef(target) IS DISTINCT FROM patched THEN
  RAISE EXCEPTION 'DAILY_REVISION_NOOP_POSTIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
END $install$;
COMMIT;
