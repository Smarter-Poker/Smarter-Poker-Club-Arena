-- The existing settlement audit advanced beyond its corrected C1 aggregate,
-- then reached 120 seconds counting first_attempt_at in section G. Its table
-- has approximately 10.76 million rows and no matching timestamp index.
-- Preserve the complete financial function, every status, strict lower time
-- boundary and future rows. A narrow online btree supports both existing
-- 24-hour and 60-minute counts without changing either query or its timeout.
--
-- First complete scripts/ci/fixtures/settlement-attribution/build-first-attempt-index.sql
-- through the maintained native TLS session route. CONCURRENTLY cannot run
-- inside BEGIN. Read the same operation's durable outcome; never retry an
-- unknown result. This short recording transaction refuses missing, invalid or
-- changed indexes and never falls back to a blocking build or financial call.
-- Existing DDL/freeze restrictions remain active. No grants, records, function
-- bodies, schedules, status filters or table maintenance options are changed.
-- @live-proof: (SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid=to_regclass('public.idx_settlement_idem_first_attempt'))
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='8s';
DO $verify$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure))
       IS DISTINCT FROM 'dbaa8f091599d0ecd9bdb2e56b85536f' THEN
    RAISE EXCEPTION 'SETTLEMENT_ATTEMPT_INDEX_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_proc p WHERE p.oid='public.fn_ca_settlement_correctness_check()'::regprocedure
      AND p.proowner='postgres'::regrole
      AND p.proacl=ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[]
      AND p.proconfig=ARRAY['search_path=public']::text[] AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'SETTLEMENT_ATTEMPT_INDEX_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE c.oid='public.settlement_idempotency_keys'::regclass
      AND c.relkind='r' AND c.relowner='postgres'::regrole
      AND a.attname='first_attempt_at' AND a.atttypid='timestamptz'::regtype
      AND a.attnotnull AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'SETTLEMENT_ATTEMPT_INDEX_TABLE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.idx_settlement_idem_first_attempt') IS NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_ATTEMPT_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    JOIN pg_am am ON am.oid=ix.relam
    WHERE i.indexrelid='public.idx_settlement_idem_first_attempt'::regclass
      AND i.indrelid='public.settlement_idempotency_keys'::regclass
      AND ix.relowner='postgres'::regrole AND ix.relkind='i' AND am.amname='btree'
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indoption::text='0'
      AND i.indcollation::text='0' AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid,1,true)='first_attempt_at'
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='timestamptz_ops' AND opcmethod=ix.relam)
  ) THEN
    RAISE EXCEPTION 'SETTLEMENT_ATTEMPT_INDEX_CONTRACT_CHANGED' USING ERRCODE='55000';
  END IF;
END
$verify$;
COMMIT;
