-- Exact receipt identity projection exceeded12s while fetching the wide heap.
-- Keep every existing unique key, receipt, financial path and retention rule.
-- The bounded range needs only fixed-width number/id/table columns. Build its
-- nonunique cover once online using build-coverage-receipt-index.sql through
-- the maintained native TLS route, outside BEGIN. This short transaction only
-- verifies the completed index. Unknown outcomes require durable catalog and
-- progress readback; qualified same-target recovery is explicit, never a loop.
-- @live-proof: (SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid=to_regclass('public.idx_hand_atomic_commit_identity'))
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='8s';
DO $verify$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure))
       IS DISTINCT FROM 'dbaa8f091599d0ecd9bdb2e56b85536f'
     OR md5(pg_get_functiondef('public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure))
       IS DISTINCT FROM 'b49192e78f472d7a931bcf20de46a702'
     OR md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))
       IS DISTINCT FROM 'f75b94afaf46ff91db120bc34e1dc2ae' THEN
    RAISE EXCEPTION 'ATOMIC_RECEIPT_INDEX_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_class WHERE oid='public.hand_atomic_commits'::regclass
      AND relkind='r' AND relowner='postgres'::regrole AND relrowsecurity)
     OR (SELECT count(*) FROM pg_attribute a JOIN (VALUES
       ('hand_id','uuid'::regtype,true),('table_id','uuid'::regtype,true),
       ('hand_number','bigint'::regtype,true)
     ) expected(name,typ,nn) ON a.attname=expected.name AND a.atttypid=expected.typ
       AND a.attnotnull=expected.nn AND NOT a.attisdropped
       WHERE a.attrelid='public.hand_atomic_commits'::regclass) <> 3 THEN
    RAISE EXCEPTION 'ATOMIC_RECEIPT_INDEX_TABLE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.idx_hand_atomic_commit_identity') IS NULL THEN
    RAISE EXCEPTION 'ATOMIC_RECEIPT_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    JOIN pg_am am ON am.oid=ix.relam
    WHERE i.indexrelid='public.idx_hand_atomic_commit_identity'::regclass
      AND i.indrelid='public.hand_atomic_commits'::regclass
      AND ix.relowner='postgres'::regrole AND ix.relkind='i' AND am.amname='btree'
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indnkeyatts=1 AND i.indnatts=3 AND i.indoption::text='0'
      AND i.indcollation::text='0' AND i.indexprs IS NULL AND i.indpred IS NULL
      AND ARRAY[pg_get_indexdef(i.indexrelid,1,true),pg_get_indexdef(i.indexrelid,2,true),
                pg_get_indexdef(i.indexrelid,3,true)]
          =ARRAY['hand_number','hand_id','table_id']::text[]
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='int8_ops' AND opcmethod=ix.relam)
  ) THEN
    RAISE EXCEPTION 'ATOMIC_RECEIPT_INDEX_CONTRACT_CHANGED' USING ERRCODE='55000';
  END IF;
END
$verify$;
COMMIT;
