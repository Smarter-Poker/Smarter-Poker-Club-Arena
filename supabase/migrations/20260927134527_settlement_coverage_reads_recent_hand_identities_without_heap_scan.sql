-- Exact all-player settlement coverage needs recent hand identity columns.
-- The original history-only projection exceeded15s while fetching the heap;
-- existing time indexes do not include id/table_id/hand_number. This narrow
-- fixed-width cover supports that projection without copying JSON or players.
-- Build online once with build-coverage-history-index.sql, outside BEGIN,
-- through the maintained native TLS route. Unknown outcome requires durable
-- readback; qualified invalid-index recovery is explicit and same-target only.
-- This short recording migration changes no function, permissions, retention,
-- rows, constraints, existing indexes, schedules or table maintenance options.
-- @live-proof: (SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid=to_regclass('public.idx_hand_history_time_identity'))
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='8s';
DO $verify$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure))
       IS DISTINCT FROM 'dbaa8f091599d0ecd9bdb2e56b85536f'
     OR md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))
       IS DISTINCT FROM 'f75b94afaf46ff91db120bc34e1dc2ae' THEN
    RAISE EXCEPTION 'HAND_COVERAGE_INDEX_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_class WHERE oid='public.hand_history'::regclass
      AND relkind='r' AND relowner='postgres'::regrole AND relrowsecurity)
     OR (SELECT count(*) FROM pg_attribute a JOIN (VALUES
       ('id','uuid'::regtype,true),('table_id','uuid'::regtype,false),
       ('hand_number','integer'::regtype,false),('created_at','timestamptz'::regtype,false)
     ) expected(name,typ,nn) ON a.attname=expected.name AND a.atttypid=expected.typ
       AND a.attnotnull=expected.nn AND NOT a.attisdropped
       WHERE a.attrelid='public.hand_history'::regclass) <> 4 THEN
    RAISE EXCEPTION 'HAND_COVERAGE_INDEX_TABLE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.idx_hand_history_time_identity') IS NULL THEN
    RAISE EXCEPTION 'HAND_COVERAGE_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    JOIN pg_am am ON am.oid=ix.relam
    WHERE i.indexrelid='public.idx_hand_history_time_identity'::regclass
      AND i.indrelid='public.hand_history'::regclass
      AND ix.relowner='postgres'::regrole AND ix.relkind='i' AND am.amname='btree'
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indnkeyatts=1 AND i.indnatts=4 AND i.indoption::text='0'
      AND i.indcollation::text='0' AND i.indexprs IS NULL AND i.indpred IS NULL
      AND ARRAY[pg_get_indexdef(i.indexrelid,1,true),pg_get_indexdef(i.indexrelid,2,true),
                pg_get_indexdef(i.indexrelid,3,true),pg_get_indexdef(i.indexrelid,4,true)]
          =ARRAY['created_at','id','table_id','hand_number']::text[]
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='timestamptz_ops' AND opcmethod=ix.relam)
  ) THEN
    RAISE EXCEPTION 'HAND_COVERAGE_INDEX_CONTRACT_CHANGED' USING ERRCODE='55000';
  END IF;
END
$verify$;
COMMIT;
