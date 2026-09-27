-- Isolated first-event connected diagnostic. It deliberately rolls back.
-- This is not historical settlement, a production probe, or complete qualification.
SET timezone='UTC';
SELECT set_config('archive_qualification.execution_uuid', :'execution_uuid', false);
DO $$ BEGIN
 IF session_user<>'fixture_bootstrap' OR current_user<>'fixture_bootstrap'
 OR current_database()<>'qual_spin_expiry_'||replace(current_setting('archive_qualification.execution_uuid'),'-','')
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_setting('session_replication_role')<>'origin'
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN
 RAISE EXCEPTION 'ARCHIVED_FIRST_PRIVATE_ALLOCATION_REQUIRED'; END IF;
END $$;

BEGIN;
CREATE OR REPLACE FUNCTION public.release_tournament_leases_v2(p_instance_id text, p_claims jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_claims IS NULL
     OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'release_tournament_leases_v2 requires instance_id and a JSON claim array'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_claims) item
     WHERE jsonb_typeof(item) <> 'object'
        OR length(btrim(COALESCE(item ->> 'tournament_id', ''))) = 0
        OR length(btrim(COALESCE(item ->> 'lease_generation', ''))) = 0
  ) THEN
    RAISE EXCEPTION 'release_tournament_leases_v2 requires one exact generation per claim'
      USING ERRCODE = '22023';
  END IF;

  /* A duplicate is a malformed authority request, not a claim to silently
     omit. Fail the transaction before deleting anything. */
  IF EXISTS (
    WITH asked AS (
      SELECT (item ->> 'tournament_id')::uuid AS tournament_id
        FROM jsonb_array_elements(p_claims) item
    )
    SELECT 1
      FROM asked
     GROUP BY tournament_id
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'release_tournament_leases_v2 refuses duplicate tournaments'
      USING ERRCODE = '22023';
  END IF;

  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'tournament_id')::uuid AS tournament_id,
           (item ->> 'lease_generation')::uuid AS lease_generation
      FROM jsonb_array_elements(p_claims) item
  )
  DELETE FROM public.engine_tournament_leases l
   USING asked a
   WHERE l.tournament_id = a.tournament_id
     AND l.instance_id = p_instance_id
     AND l.protocol_version = 2
     AND l.lease_generation = a.lease_generation;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
ALTER FUNCTION public.release_tournament_leases_v2(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_tournament_leases_v2(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.release_tournament_leases_v2(text,jsonb) TO service_role;
DO $$ BEGIN IF (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid='public.release_tournament_leases_v2(text,jsonb)'::regprocedure) IS DISTINCT FROM '2c92f4af8b6f14b8cdc0a5af7e98fcf8' THEN RAISE EXCEPTION 'ARCHIVE_REAL_MANAGER_RELEASE_SOURCE_CHANGED'; END IF; END $$;
DO $$ DECLARE actual jsonb; BEGIN
 SELECT jsonb_build_object('owner',pg_get_userbyid(proowner),'config',proconfig,'security_definer',prosecdef,
  'acl',(SELECT jsonb_agg(v::text ORDER BY v::text) FROM unnest(coalesce(proacl,acldefault('f',proowner)))v)) INTO actual
 FROM pg_proc WHERE oid='public.release_tournament_leases_v2(text,jsonb)'::regprocedure;
 IF actual IS DISTINCT FROM '{"owner":"postgres","config":["search_path=public, pg_temp"],"security_definer":true,"acl":["postgres=X/postgres","service_role=X/postgres"]}'::jsonb THEN
  RAISE EXCEPTION 'ARCHIVE_REAL_MANAGER_RELEASE_AUTHORITY_CHANGED' USING DETAIL=actual::text; END IF;
END $$;
COMMIT;
