-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='f34d0a20bf04f57066005e3ca30bab6a' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}' AND prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'] FROM pg_proc WHERE oid='smarter_private.f06_state(uuid)'::regprocedure)
-- Park grace belongs to the original durable park, not its current Manager.
-- Metadata only: expose its immutable creation timestamp through the existing
-- private state reader; retain every movement proof, role and custody authority.
-- No public relation lock or business-row write is required. Install only from
-- protected main through Apply Merged Migration, outside its existing DDL guard.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $park_created_at$
DECLARE
 original text;
 authority jsonb;
 anchor constant text := '''state'',o.state,''revision''';
 replacement constant text := '''state'',o.state,''park_created_at'',o.created_at,''revision''';
BEGIN
 SELECT pg_get_functiondef(p.oid),jsonb_build_array(p.proowner,p.proacl,p.proconfig,p.prosecdef,p.provolatile)
 INTO original,authority FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_state(uuid)');
 IF original IS NULL OR md5(original)<>'79e9eabbf0ba90948782da3ff9116c34'
    OR (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'F06_PARK_CREATED_AT_PREIMAGE_DRIFT';
 END IF;
 EXECUTE replace(original,anchor,replacement);
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='smarter_private.f06_state(uuid)'::regprocedure
   AND pg_get_functiondef(p.oid)=replace(original,anchor,replacement)
   AND jsonb_build_array(p.proowner,p.proacl,p.proconfig,p.prosecdef,p.provolatile)=authority) THEN
  RAISE EXCEPTION 'F06_PARK_CREATED_AT_POSTIMAGE_DRIFT';
 END IF;
END $park_created_at$;
COMMIT;
