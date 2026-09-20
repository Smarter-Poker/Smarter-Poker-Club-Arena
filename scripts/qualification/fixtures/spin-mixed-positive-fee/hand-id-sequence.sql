-- Fee-only isolated provider initialization; never a production migration.
-- Capture: hand-id-sequence-capture.json, 2026-09-18T01:56:47.003326+00:00.
-- Original SHA256 a86f2f81e2ed49bf347c9806a9279b8f8e437c10642de163ee2bd8c5d05f92f1.
-- Production counters were not captured. The restart below initializes only
-- this fresh, verified-unused fixture to the captured configuration's start.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=pg_catalog,public;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='1s';
SELECT set_config('qualification.socket_directory', :'qualification_socket', true);

DO $boundary$
DECLARE execution text := current_setting('qualification.execution_uuid');
BEGIN
 IF current_user<>'fixture_bootstrap' OR session_user<>'fixture_bootstrap'
    OR execution !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR current_database()<>'qual_spin_expiry_'||replace(execution,'-','')
    OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
    OR current_setting('port')<>'5432'
    OR current_setting('qualification.socket_directory') !~ '^/[^,]+/work/socket$'
    OR current_setting('unix_socket_directories')<>current_setting('qualification.socket_directory')
    OR current_setting('session_replication_role')<>'origin'
    OR current_setting('transaction_isolation')<>'read committed'
    OR (SELECT rolsuper FROM pg_roles WHERE rolname='postgres') IS DISTINCT FROM false
    OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())
 THEN RAISE EXCEPTION 'fee sequence requires sole exact isolated PG17 bootstrap/private endpoint' USING ERRCODE='55000'; END IF;
END $boundary$;

CREATE FUNCTION pg_temp.fee_sequence_empty_estate() RETURNS integer LANGUAGE plpgsql AS $empty$
DECLARE r record; occupied boolean; checked integer := 0;
BEGIN
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN('auth','public','smarter_private') AND c.relkind IN('r','p'))>400
 THEN RAISE EXCEPTION 'fee sequence empty-estate bound exceeded'; END IF;
 FOR r IN SELECT c.oid::regclass name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('auth','public','smarter_private') AND c.relkind IN('r','p')
     AND c.oid NOT IN('auth.users'::regclass,'public.profiles'::regclass,'public.ca_settle_sources'::regclass)
   ORDER BY c.oid
 LOOP
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s LIMIT 1)',r.name) INTO occupied;
   IF occupied THEN RAISE EXCEPTION 'fee sequence requires empty business estate: %',r.name; END IF;
   checked := checked+1;
 END LOOP;
 IF checked=0 OR (SELECT count(*) FROM auth.users)<>4 OR (SELECT count(*) FROM public.profiles)<>3
    OR EXISTS(SELECT 1 FROM public.profiles WHERE diamonds IS DISTINCT FROM 0
       OR diamond_balance IS DISTINCT FROM 0 OR is_horse IS DISTINCT FROM false OR role IS DISTINCT FROM 'user')
    OR (SELECT count(*) FROM public.ca_settle_sources)<>1
    OR NOT EXISTS(SELECT 1 FROM public.ca_settle_sources WHERE source='atomic_cancel_tournament'
       AND note='20260909014444: atomic cancellation receipt authority'
       AND added_at=TIMESTAMPTZ '2026-09-05 20:33:01.099866+00')
 THEN RAISE EXCEPTION 'fee sequence initial principals/reference estate differs'; END IF;
 RETURN checked;
END $empty$;

CREATE FUNCTION pg_temp.fee_sequence_catalog() RETURNS jsonb LANGUAGE sql STABLE AS $catalog$
 SELECT jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,
   'persistence',c.relpersistence,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,
   'type',format_type(s.seqtypid,NULL),'start',s.seqstart::text,'increment',s.seqincrement::text,
   'min',s.seqmin::text,'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle,
   'owned_dependencies',(SELECT count(*) FROM pg_depend d WHERE d.classid='pg_class'::regclass
      AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN('a','i')))
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid
 WHERE n.nspname='public' AND c.relname='hand_id_seq'
$catalog$;

DO $preimage$
BEGIN
 PERFORM pg_temp.fee_sequence_empty_estate();
 IF pg_temp.fee_sequence_catalog() IS DISTINCT FROM
    '{"schema":"public","name":"hand_id_seq","kind":"S","persistence":"p","owner":"fixture_bootstrap","acl":null,"type":"bigint","start":"1","increment":"1","min":"1","max":"9223372036854775807","cache":"1","cycle":false,"owned_dependencies":0}'::jsonb
 THEN RAISE EXCEPTION 'fee sequence exact original authority/configuration differs' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.hand_id_seq WHERE last_value=1 AND is_called=false)
 THEN RAISE EXCEPTION 'fee sequence is not fresh and unused; restart refused' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
   JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE c.oid='public.rake_records'::regclass AND c.relkind='r' AND pg_get_userbyid(c.relowner)='postgres'
     AND a.attname='global_hand_id' AND a.atttypid='bigint'::regtype AND NOT a.attisdropped
     AND a.attidentity='' AND a.attgenerated=''
     AND pg_get_expr(d.adbin,d.adrelid,false)='nextval(''hand_id_seq''::regclass)')
 THEN RAISE EXCEPTION 'fee sequence authentic rake default differs'; END IF;
END $preimage$;

ALTER SEQUENCE public.hand_id_seq INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807
  START WITH 1000000 RESTART WITH 1000000 CACHE 100 NO CYCLE;
ALTER SEQUENCE public.hand_id_seq OWNER TO postgres;
SET LOCAL ROLE postgres;
GRANT SELECT,UPDATE,USAGE ON SEQUENCE public.hand_id_seq TO postgres,anon,authenticated,service_role;
RESET ROLE;

DO $postimage$
DECLARE role_name text;
BEGIN
 IF pg_temp.fee_sequence_catalog() IS DISTINCT FROM
    '{"schema":"public","name":"hand_id_seq","kind":"S","persistence":"p","owner":"postgres","acl":"{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}","type":"bigint","start":"1000000","increment":"1","min":"1","max":"9223372036854775807","cache":"100","cycle":false,"owned_dependencies":0}'::jsonb
 THEN RAISE EXCEPTION 'fee sequence exact captured authority/configuration differs' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.hand_id_seq WHERE last_value=1000000 AND is_called=false)
 THEN RAISE EXCEPTION 'fee sequence fresh initialization differs'; END IF;
 FOREACH role_name IN ARRAY ARRAY['postgres','anon','authenticated','service_role'] LOOP
   IF NOT has_sequence_privilege(role_name,'public.hand_id_seq','SELECT')
      OR NOT has_sequence_privilege(role_name,'public.hand_id_seq','UPDATE')
      OR NOT has_sequence_privilege(role_name,'public.hand_id_seq','USAGE')
   THEN RAISE EXCEPTION 'fee sequence captured privileges differ for %',role_name; END IF;
 END LOOP;
 PERFORM pg_temp.fee_sequence_empty_estate();
END $postimage$;

SELECT jsonb_build_object('stage','positive_fee_hand_id_sequence','execution_uuid',current_setting('qualification.execution_uuid'),
 'database',current_database(),'user',current_user,'session_user',session_user,
 'socket',current_setting('unix_socket_directories'),'sequence',pg_temp.fee_sequence_catalog(),
 'empty_tables_checked',pg_temp.fee_sequence_empty_estate(),'empty_business_estate',true,
 'fresh_isolated_initialization_only',true,'production_counter_copied',false,
 'financial_qualification',false,'historical_qualification',false,'production_qualification',false);
COMMIT;
