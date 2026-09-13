// Actual PostgreSQL statements. Portable tests exercise orchestration only;
// these assertions qualify providers only when real native CI executes them.
export const providerVersions = Object.freeze({ http: '1.6', pg_net: '0.19.5', plpgsql_check: '2.7', postgis: '3.3.7', supabase_vault: '0.3.1' });
export const providerSql = Object.freeze({
  identity: `SELECT pg_backend_pid() AS pid, current_database() AS database,
    current_user AS role, session_user AS session_role, inet_server_addr() IS NULL AS local,
    current_setting('is_superuser')::boolean AS superuser,
    current_setting('default_transaction_read_only') AS read_only,
    current_setting('server_version_num') AS version_num`,
  empty: `SELECT NOT EXISTS(SELECT FROM pg_extension WHERE extname=ANY($1::text[]))
    AND to_regnamespace('net') IS NULL AND to_regnamespace('vault') IS NULL
    AND to_regnamespace('fixture_provider_probe') IS NULL AS empty`,
  install: `BEGIN;
    CREATE EXTENSION postgis WITH SCHEMA extensions VERSION '3.3.7';
    CREATE EXTENSION http WITH SCHEMA extensions VERSION '1.6';
    CREATE EXTENSION plpgsql_check WITH SCHEMA extensions VERSION '2.7';
    CREATE EXTENSION supabase_vault VERSION '0.3.1';
    CREATE EXTENSION pg_net WITH SCHEMA extensions VERSION '0.19.5';
    CREATE SCHEMA fixture_provider_probe AUTHORIZATION supabase_admin;
    COMMIT`,
  inventory: `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema,
    pg_get_userbyid(e.extowner) AS owner
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname=ANY($1::text[]) ORDER BY e.extname`,
  catalog: `SELECT e.extname AS extension, n.nspname AS schema, p.proname AS name,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    l.lanname AS language, p.prosrc AS symbol_or_body, p.probin AS library,
    pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
    p.proconfig AS settings,
    ARRAY(SELECT a::text FROM unnest(p.proacl) a ORDER BY a::text) AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
    JOIN pg_extension e ON e.oid=d.refobjid
    WHERE e.extname=ANY($1::text[]) ORDER BY e.extname,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`,
  acl: `SELECT
    NOT has_schema_privilege('anon','vault','USAGE') AS vault_schema_denied,
    NOT has_function_privilege('anon','vault.create_secret(text,text,text,uuid)','EXECUTE') AS vault_create_denied,
    NOT has_table_privilege('anon','vault.secrets','SELECT') AS vault_table_denied,
    has_schema_privilege('anon','net','USAGE') AS net_schema_public,
    has_function_privilege('anon','net.http_get(text,jsonb,jsonb,integer)','EXECUTE') AS net_get_public,
    has_table_privilege('anon','net.http_request_queue','INSERT') AS net_queue_public,
    has_function_privilege('anon','extensions.http_get(character varying)','EXECUTE') AS http_public,
    has_schema_privilege('anon','extensions','USAGE') AS extensions_usage,
    NOT has_schema_privilege('anon','extensions','CREATE') AS extensions_create_denied`,
  preload: `SELECT current_setting('shared_preload_libraries') AS libraries,
    current_setting('pg_net.database_name') AS database,
    current_setting('pg_net.username') AS username,
    current_setting('vault.getkey_script') AS key_script`,
  worker: `SELECT count(*)::integer AS workers FROM pg_stat_activity
    WHERE backend_type='pg_net 0.19.5 worker' AND application_name='pg_net 0.19.5'
    AND datname=current_database() AND usename='supabase_admin'`,
  postgis: `BEGIN;
    CREATE TABLE fixture_provider_probe.points(id integer PRIMARY KEY, g extensions.geometry(Point,4326));
    INSERT INTO fixture_provider_probe.points VALUES (1,extensions.ST_SetSRID(extensions.ST_MakePoint(0,0),4326)),
      (2,extensions.ST_SetSRID(extensions.ST_MakePoint(1,0),4326));
    CREATE INDEX provider_points_gist ON fixture_provider_probe.points USING gist(g);
    DO $probe$ BEGIN
      IF extensions.postgis_lib_version() <> '3.3.7'
        OR (SELECT extensions.ST_Distance(a.g::extensions.geography,b.g::extensions.geography)
              BETWEEN 111000 AND 112000 FROM fixture_provider_probe.points a,fixture_provider_probe.points b
              WHERE a.id=1 AND b.id=2) IS NOT TRUE
        OR (SELECT count(*) FROM fixture_provider_probe.points
            WHERE g OPERATOR(extensions.&&) extensions.ST_MakeEnvelope(-0.1,-0.1,0.1,0.1,4326)) <> 1
      THEN RAISE EXCEPTION 'FIXTURE_PROVIDER_SPATIAL'; END IF;
    END $probe$;
    SET LOCAL enable_seqscan=off;
    EXPLAIN (FORMAT JSON) SELECT id FROM fixture_provider_probe.points
      WHERE g OPERATOR(extensions.&&) extensions.ST_MakeEnvelope(-0.1,-0.1,0.1,0.1,4326);
    ROLLBACK`,
  plpgsql: `BEGIN;
    CREATE FUNCTION fixture_provider_probe.valid_fn(integer) RETURNS integer LANGUAGE plpgsql
      AS 'BEGIN RETURN $1 + 1; END';
    CREATE FUNCTION fixture_provider_probe.invalid_fn() RETURNS integer LANGUAGE plpgsql
      AS 'BEGIN RETURN missing_provider_variable; END';
    DO $probe$ BEGIN
      IF EXISTS (SELECT FROM extensions.plpgsql_check_function_tb('fixture_provider_probe.valid_fn(integer)'::regprocedure))
        OR NOT EXISTS (SELECT FROM extensions.plpgsql_check_function_tb('fixture_provider_probe.invalid_fn()'::regprocedure)
                       WHERE sqlstate='42703' AND level='error')
      THEN RAISE EXCEPTION 'FIXTURE_PROVIDER_PLPGSQL_CHECK'; END IF;
    END $probe$;
    ROLLBACK`,
  vaultCreate: `SELECT vault.create_secret($1,'fixture-provider-dummy','Disposable synthetic probe') AS id`,
  vaultRead: `SELECT s.secret <> $2 AS encrypted, d.decrypted_secret=$2 AS decrypted,
    octet_length(decode(s.secret,'base64')) > octet_length(convert_to($2,'utf8')) AS authenticated_ciphertext
    FROM vault.secrets s JOIN vault.decrypted_secrets d USING(id) WHERE s.id=$1::uuid`,
  vaultUpdate: `SELECT vault.update_secret($1::uuid,$2)`,
  vaultDenied: `SELECT vault.create_secret('fixture-denied','fixture-denied','')`,
  httpOptions: `SELECT extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','2000') AS timeout,
    extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS','1000') AS connect_timeout,
    extensions.http_set_curlopt('CURLOPT_FOLLOWLOCATION','0') AS redirects`,
  http: `SELECT status, content_type, content FROM extensions.http_get($1::varchar)`,
  enqueue: `SELECT net.http_get(url:=$1,timeout_milliseconds:=2000) AS id`,
  queueInvisible: `SELECT NOT EXISTS(SELECT FROM net.http_request_queue WHERE id=$1::bigint)
    AND NOT EXISTS(SELECT FROM net._http_response WHERE id=$1::bigint) AS absent`,
  response: `SELECT status_code,content,timed_out,error_msg FROM net._http_response WHERE id=$1::bigint`,
  cleaned: `SELECT to_regnamespace('fixture_provider_probe') IS NULL
    AND NOT EXISTS(SELECT FROM net._http_response WHERE id=ANY($1::bigint[]))
    AND NOT EXISTS(SELECT FROM net.http_request_queue WHERE id=ANY($1::bigint[]))
    AND NOT EXISTS(SELECT FROM vault.secrets WHERE id=$2::uuid) AS cleaned`,
});
