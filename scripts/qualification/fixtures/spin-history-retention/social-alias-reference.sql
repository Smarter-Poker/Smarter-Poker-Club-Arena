-- One captured horse-author vocabulary projection, for isolated rollback fixtures only.
-- Source: social-alias-reference-authority.json, observed 2026-09-17T08:38:40.215382Z.
-- Source author id is provenance only. Use a new sequence id, NULL profile and
-- inactive state; this is not a restored author identity or financial authority.
-- Include INSIDE the existing fixture BEGIN, after its initial full-state snapshot
-- and before the actual horse UPDATE. Real social writer/trigger and its assertions
-- remain unchanged; the outer full-state rollback must remove this reference row.
DO $retention_social_reference$
DECLARE
 v_projection jsonb := $projection${"name":"Brandon Hayes","alias":"MintJulep","location":"Phoenix, AZ","timezone":"America/Chicago","source_author_id":6}$projection$::jsonb;
 v_row jsonb;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
  OR current_setting('qualification.execution_uuid',true) IS NULL
  OR current_setting('spin_retention_fixture.execution',true) IS DISTINCT FROM current_setting('qualification.execution_uuid',true)
  OR current_setting('qualification.execution_uuid',true) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR current_database()<>'qual_spin_expiry_'||replace(current_setting('qualification.execution_uuid',true),'-','')
  OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
  OR md5(v_projection::text)<>'008387f0ecf4ee362f26433a7d3e3c27'
  OR (regexp_match(v_projection->>'alias','^([A-Z][a-z]+)'))[1] IS NULL
  OR (regexp_match(v_projection->>'alias','^[A-Z][a-z]+([A-Z][a-z]+)'))[1] IS NULL
  OR EXISTS(SELECT 1 FROM public.content_authors) THEN
  RAISE EXCEPTION 'retention social reference: exact isolated empty vocabulary required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.content_authors'::regclass
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='postgres' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND c.relacl::text='{postgres=arwdDxtm/postgres,anon=arwdxtm/postgres,authenticated=arwdxtm/postgres,service_role=arwdDxtm/postgres}')
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.content_authors'::regclass AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'retention social reference: captured table authority differs'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_mint_social_alias(text)')
  AND md5(pg_get_functiondef(p.oid))='d7836a0bc27404d3a5d7e04f942b3738' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
  RAISE EXCEPTION 'retention social reference: captured function authority differs %','fn_mint_social_alias(text)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_socialize_horse(uuid)')
  AND md5(pg_get_functiondef(p.oid))='e5cfcdd4c97458aca7a2e195dc549117' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
  RAISE EXCEPTION 'retention social reference: captured function authority differs %','fn_socialize_horse(uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.trg_fn_horse_is_born_social()')
  AND md5(pg_get_functiondef(p.oid))='b0edf65c444bdd477f2e079d5d6b15ce' AND pg_get_userbyid(p.proowner)='postgres'
  AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
  RAISE EXCEPTION 'retention social reference: captured function authority differs %','trg_fn_horse_is_born_social()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.profiles'::regclass
  AND t.tgname='trg_profiles_horse_is_born_social' AND t.tgenabled='O' AND t.tgtype=21
  AND t.tgfoid='public.trg_fn_horse_is_born_social()'::regprocedure
  AND pg_get_triggerdef(t.oid,true)=$binding$CREATE TRIGGER trg_profiles_horse_is_born_social AFTER INSERT OR UPDATE OF is_horse ON profiles FOR EACH ROW WHEN (new.is_horse IS TRUE) EXECUTE FUNCTION trg_fn_horse_is_born_social()$binding$) THEN
  RAISE EXCEPTION 'retention social reference: captured profile trigger differs'; END IF;
 INSERT INTO public.content_authors(name,alias,location,timezone,profile_id,is_active)
 VALUES(v_projection->>'name',v_projection->>'alias',v_projection->>'location',v_projection->>'timezone',NULL,false)
 RETURNING to_jsonb(content_authors) INTO v_row;
 IF (SELECT count(*) FROM public.content_authors)<>1 OR (v_row->>'id')::integer<=0
  OR v_row IS DISTINCT FROM jsonb_build_object(
    'id',v_row->'id','name',v_projection->'name','alias',v_projection->'alias',
    'location',v_projection->'location','timezone',v_projection->'timezone',
    'created_at',transaction_timestamp(),'is_active',false,'profile_id',NULL,
    'gender',NULL,'birthday',NULL,'specialty',NULL,'stakes',NULL,'bio',NULL,
    'voice',NULL,'avatar_seed',NULL,'avatar_url',NULL,'personality',NULL) THEN
  RAISE EXCEPTION 'retention social reference: inserted projection differs'; END IF;
END $retention_social_reference$;
