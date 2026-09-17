-- Isolated provider correction from fifo5-retention-content-author-sequence-
-- 20260917.json, captured 07:18:42.642925 UTC. No counter reset or business call.
-- The base bare CREATE defaults to bigint/fixture_bootstrap/no ACL/OWNED BY;
-- restore the captured integer definition and exact owner/ACL/dependency.
DO $preimage$
BEGIN
 IF current_user<>'fixture_bootstrap' OR session_user<>'fixture_bootstrap'
  OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_retention_fixture.execution'),'-','')
  OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres' AND NOT rolsuper)
  OR NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid
    WHERE c.oid=to_regclass('public.content_authors_id_seq') AND c.relkind='S'
    AND c.relpersistence='p' AND pg_get_userbyid(c.relowner)='fixture_bootstrap'
    AND c.relacl IS NULL AND s.seqtypid='bigint'::regtype AND s.seqstart=1
    AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=9223372036854775807
    AND s.seqcache=1 AND NOT s.seqcycle)
  OR EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_class'::regclass
    AND objid='public.content_authors_id_seq'::regclass AND refclassid='pg_class'::regclass AND deptype IN('a','i'))
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    WHERE c.oid='public.content_authors'::regclass AND pg_get_userbyid(c.relowner)='postgres'
      AND a.attname='id' AND a.atttypid='integer'::regtype AND a.attidentity='' AND a.attgenerated='') THEN
   RAISE EXCEPTION 'retention sequence: exact isolated base preimage required'; END IF;
END $preimage$;
CREATE TEMP TABLE retention_sequence_before AS SELECT last_value,is_called FROM public.content_authors_id_seq;
ALTER SEQUENCE public.content_authors_id_seq AS integer MINVALUE 1 MAXVALUE 2147483647;
ALTER SEQUENCE public.content_authors_id_seq OWNER TO postgres;
ALTER SEQUENCE public.content_authors_id_seq OWNED BY public.content_authors.id;
SET LOCAL ROLE postgres;
REVOKE ALL ON SEQUENCE public.content_authors_id_seq FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT ALL ON SEQUENCE public.content_authors_id_seq TO postgres;
GRANT ALL ON SEQUENCE public.content_authors_id_seq TO anon;
GRANT ALL ON SEQUENCE public.content_authors_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.content_authors_id_seq TO service_role;
RESET ROLE;
DO $postimage$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid
   WHERE c.oid='public.content_authors_id_seq'::regclass AND c.relkind='S' AND c.relpersistence='p'
     AND pg_get_userbyid(c.relowner)='postgres'
     AND c.relacl::text='{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}'
     AND s.seqtypid='integer'::regtype AND s.seqstart=1 AND s.seqincrement=1
     AND s.seqmin=1 AND s.seqmax=2147483647 AND s.seqcache=1 AND NOT s.seqcycle)
  OR (SELECT count(*) FROM pg_depend WHERE classid='pg_class'::regclass
    AND objid='public.content_authors_id_seq'::regclass AND refclassid='pg_class'::regclass AND deptype IN('a','i'))<>1
  OR NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    WHERE d.classid='pg_class'::regclass AND d.objid='public.content_authors_id_seq'::regclass
      AND d.refclassid='pg_class'::regclass AND d.refobjid='public.content_authors'::regclass
      AND a.attname='id' AND d.deptype='a')
  OR (SELECT ROW(last_value,is_called) FROM public.content_authors_id_seq)
     IS DISTINCT FROM (SELECT ROW(last_value,is_called) FROM retention_sequence_before) THEN
  RAISE EXCEPTION 'retention sequence: exact authority/counter preservation failed'; END IF;
END $postimage$;
DROP TABLE retention_sequence_before;
