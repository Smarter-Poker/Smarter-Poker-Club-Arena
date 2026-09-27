-- Match every recent hand to its common canonical commit receipt. The prior
-- human-only denominator could be inflated by horse settlement claims; diamond
-- cash legitimately uses a different lower-level receipt. All formats now use
-- hand_atomic_commits with exact hand/table/number identity, one shared snapshot,
-- unchanged24h/1h/adoption arithmetic and no horse/asset exclusion.
-- All other financial function bytes, permissions, schedules and retention stay.
-- Qualify the separate fixed-width history covering index before this change.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure)) = '331dfe59b157b733bc1efc99bbf193d0')
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='8s';
DO $repair$
DECLARE v_before text; v_next text; v_authority jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid),jsonb_build_object('oid',p.oid,'owner',p.proowner,
    'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile)
    INTO v_before,v_authority FROM pg_proc p
    WHERE p.oid='public.fn_ca_settlement_correctness_check()'::regprocedure;
  IF md5(v_before) IS DISTINCT FROM 'dbaa8f091599d0ecd9bdb2e56b85536f' THEN
    RAISE EXCEPTION 'SETTLEMENT_COVERAGE_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_proc WHERE oid='public.fn_ca_settlement_correctness_check()'::regprocedure
      AND proowner='postgres'::regrole AND prosecdef AND provolatile='v')
    OR has_function_privilege('anon','public.fn_ca_settlement_correctness_check()','EXECUTE')
    OR has_function_privilege('authenticated','public.fn_ca_settlement_correctness_check()','EXECUTE')
    OR NOT has_function_privilege('service_role','public.fn_ca_settlement_correctness_check()','EXECUTE') THEN
    RAISE EXCEPTION 'SETTLEMENT_COVERAGE_AUTHORITY_PREIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure))
        IS DISTINCT FROM 'b49192e78f472d7a931bcf20de46a702'
    OR md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))
        IS DISTINCT FROM 'f75b94afaf46ff91db120bc34e1dc2ae' THEN
    RAISE EXCEPTION 'SETTLEMENT_COVERAGE_PRODUCER_OR_RETENTION_CHANGED' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a JOIN (VALUES
      ('hand_id','uuid'::regtype),('table_id','uuid'::regtype),('hand_number','bigint'::regtype)
    ) expected(name,typ) ON a.attname=expected.name AND a.atttypid=expected.typ
      AND a.attnotnull AND NOT a.attisdropped WHERE a.attrelid='public.hand_atomic_commits'::regclass) <> 3 THEN
    RAISE EXCEPTION 'SETTLEMENT_COVERAGE_RECEIPT_COLUMNS_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_index i WHERE i.indrelid='public.hand_atomic_commits'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND i.indnkeyatts=1 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid,1,true)='hand_id') THEN
    RAISE EXCEPTION 'SETTLEMENT_COVERAGE_RECEIPT_IDENTITY_CHANGED' USING ERRCODE='55000';
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
  v_next := replace(v_before,$old$  -- G. Legacy-fallback alarm (phase 2b): once the engine settles ≥50% of
  -- hands through the atomic claim RPC (24h view), any last-hour coverage
  -- below 90% means a regression re-opened the unsafe per-seat path.
  DECLARE
    v_hands_24h bigint; v_claims_24h bigint; v_hands_1h bigint; v_claims_1h bigint;
  BEGIN
    SELECT count(*) INTO v_hands_24h FROM public.hand_history
     WHERE created_at > now() - interval '24 hours' AND has_human;
    SELECT count(*) INTO v_claims_24h FROM public.settlement_idempotency_keys
     WHERE first_attempt_at > now() - interval '24 hours';
    IF v_hands_24h > 100 AND v_claims_24h >= v_hands_24h / 2 THEN
      SELECT count(*) INTO v_hands_1h FROM public.hand_history
       WHERE created_at > now() - interval '60 minutes' AND has_human;
      SELECT count(*) INTO v_claims_1h FROM public.settlement_idempotency_keys
       WHERE first_attempt_at > now() - interval '60 minutes';
      IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_settlement_correctness_check:fallback_regression', 'settlement_error', 'warning',
          'fallback-regression:' || to_char(now(), 'YYYY-MM-DD-HH24'),
          0, v_hands_1h, v_claims_1h, 'settlement', 'settlement_idempotency_keys',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          'atomic hand settlement coverage fell to ' || v_claims_1h || '/' || v_hands_1h
            || ' hands in the last hour after adoption - the engine has regressed to the legacy per-seat write path',
          NULL, jsonb_build_object('claims_1h', v_claims_1h, 'hands_1h', v_hands_1h));
        n := n + 1;
      END IF;
    END IF;
  END;

$old$,$new$  -- G. All-player atomic coverage: both windows count the same hand identities.
  -- The common commit receipt covers ordinary and diamond hands. The existing
  -- claims metadata keys remain compatible, and now mean matched receipts.
  DECLARE
    v_hands_24h bigint; v_claims_24h bigint; v_hands_1h bigint; v_claims_1h bigint;
  BEGIN
    WITH recent AS MATERIALIZED (
      SELECT id,table_id,hand_number,created_at
      FROM public.hand_history WHERE created_at>now()-interval '24 hours'
    ), receipts AS MATERIALIZED (
      SELECT hand_id,table_id,hand_number FROM public.hand_atomic_commits
      WHERE hand_number BETWEEN (SELECT min(hand_number) FROM recent)
                            AND (SELECT max(hand_number) FROM recent)
    )
    SELECT count(*) AS hands_24h,count(c.hand_id) AS commits_24h,
           count(*) FILTER(WHERE h.created_at>now()-interval '60 minutes') AS hands_1h,
           count(c.hand_id) FILTER(WHERE h.created_at>now()-interval '60 minutes') AS commits_1h
    INTO v_hands_24h,v_claims_24h,v_hands_1h,v_claims_1h
    FROM recent h LEFT JOIN receipts c
     ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number
;
    IF v_hands_24h > 100 AND v_claims_24h >= v_hands_24h / 2 THEN
      IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_settlement_correctness_check:fallback_regression', 'settlement_error', 'warning',
          'fallback-regression:' || to_char(now(), 'YYYY-MM-DD-HH24'),
          0, v_hands_1h, v_claims_1h, 'settlement', 'hand_atomic_commits',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          'atomic hand settlement coverage fell to ' || v_claims_1h || '/' || v_hands_1h
            || ' hands in the last hour after adoption - matching atomic hand receipts are missing',
          NULL, jsonb_build_object('claims_1h', v_claims_1h, 'hands_1h', v_hands_1h));
        n := n + 1;
      END IF;
    END IF;
  END;

$new$);
  IF v_next=v_before OR md5(v_next) IS DISTINCT FROM '331dfe59b157b733bc1efc99bbf193d0' THEN
    RAISE EXCEPTION 'SETTLEMENT_COVERAGE_REPLACEMENT_CHANGED';
  END IF;
  EXECUTE v_next;
  IF v_authority IS DISTINCT FROM (SELECT jsonb_build_object('oid',p.oid,'owner',p.proowner,
      'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile)
      FROM pg_proc p WHERE p.oid='public.fn_ca_settlement_correctness_check()'::regprocedure) THEN
    RAISE EXCEPTION 'SETTLEMENT_COVERAGE_AUTHORITY_CHANGED';
  END IF;
END
$repair$;
COMMIT;
