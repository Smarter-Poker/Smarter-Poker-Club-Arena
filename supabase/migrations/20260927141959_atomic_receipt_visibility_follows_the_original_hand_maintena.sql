-- Keep the fixed-width atomic receipt cover useful between PostgreSQL's own
-- maintenance passes. On 2026-09-27 at 14:10 UTC only 557656/730144 pages were
-- all-visible; 229594 dead tuples and 101372 inserts had accumulated by 14:12
-- after the 11:30 vacuum. The old 250k/100k thresholds permitted multi-hour gaps.
-- The observed short interval was 1555 inserts/119s and about 2 updates/receipt.
-- Match hand_history's existing 10k insert cadence, with 20k dead tuples for the
-- two receipt updates. At that observed rate eligibility is about 13 minutes,
-- not a schedule or promise of worker availability. Preserve cost/freeze knobs.
-- No rows, financial function, receipt identity, index or retention is changed.
-- Official PG17 guidance: https://www.postgresql.org/docs/17/runtime-config-autovacuum.html
-- @live-proof: (SELECT count(*)=2 FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid='public.hand_atomic_commits'::regclass)) WHERE (option_name='autovacuum_vacuum_threshold' AND option_value='20000') OR (option_name='autovacuum_vacuum_insert_threshold' AND option_value='10000'))
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='8s';
DO $maintain$
DECLARE v_options jsonb; v_before jsonb; v_after jsonb;
BEGIN
  IF NOT EXISTS(SELECT FROM pg_class WHERE oid='public.hand_atomic_commits'::regclass
      AND relkind='r' AND relowner='postgres'::regrole AND relrowsecurity) THEN
    RAISE EXCEPTION 'ATOMIC_RECEIPT_MAINTENANCE_TABLE_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT jsonb_object_agg(option_name,option_value) INTO v_options
  FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid='public.hand_atomic_commits'::regclass));
  IF v_options IS DISTINCT FROM '{"autovacuum_vacuum_scale_factor":"0.0","autovacuum_vacuum_threshold":"250000","autovacuum_vacuum_insert_scale_factor":"0.0","autovacuum_vacuum_insert_threshold":"100000"}'::jsonb THEN
    RAISE EXCEPTION 'ATOMIC_RECEIPT_MAINTENANCE_OPTIONS_CHANGED' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure))
        IS DISTINCT FROM 'dbaa8f091599d0ecd9bdb2e56b85536f'
    OR md5(pg_get_functiondef('public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure))
        IS DISTINCT FROM 'b49192e78f472d7a931bcf20de46a702'
    OR md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))
        IS DISTINCT FROM 'f75b94afaf46ff91db120bc34e1dc2ae' THEN
    RAISE EXCEPTION 'ATOMIC_RECEIPT_MAINTENANCE_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT jsonb_build_object(
    'table',(SELECT jsonb_build_object('oid',oid,'owner',relowner,'acl',relacl,'rls',relrowsecurity,'force',relforcerowsecurity) FROM pg_class WHERE oid='public.hand_atomic_commits'::regclass),
    'indexes',(SELECT jsonb_agg(jsonb_build_object('oid',indexrelid,'def',pg_get_indexdef(indexrelid),'valid',indisvalid,'ready',indisready,'live',indislive) ORDER BY indexrelid) FROM pg_index WHERE indrelid='public.hand_atomic_commits'::regclass),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'def',pg_get_constraintdef(oid)) ORDER BY oid) FROM pg_constraint WHERE conrelid='public.hand_atomic_commits'::regclass OR confrelid='public.hand_atomic_commits'::regclass)
  ) INTO v_before;
  ALTER TABLE public.hand_atomic_commits SET (
    autovacuum_vacuum_threshold=20000,
    autovacuum_vacuum_insert_threshold=10000
  );
  SELECT jsonb_build_object(
    'table',(SELECT jsonb_build_object('oid',oid,'owner',relowner,'acl',relacl,'rls',relrowsecurity,'force',relforcerowsecurity) FROM pg_class WHERE oid='public.hand_atomic_commits'::regclass),
    'indexes',(SELECT jsonb_agg(jsonb_build_object('oid',indexrelid,'def',pg_get_indexdef(indexrelid),'valid',indisvalid,'ready',indisready,'live',indislive) ORDER BY indexrelid) FROM pg_index WHERE indrelid='public.hand_atomic_commits'::regclass),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'def',pg_get_constraintdef(oid)) ORDER BY oid) FROM pg_constraint WHERE conrelid='public.hand_atomic_commits'::regclass OR confrelid='public.hand_atomic_commits'::regclass)
  ) INTO v_after;
  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'ATOMIC_RECEIPT_MAINTENANCE_CATALOG_CHANGED';
  END IF;
  SELECT jsonb_object_agg(option_name,option_value) INTO v_options
  FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid='public.hand_atomic_commits'::regclass));
  IF v_options IS DISTINCT FROM '{"autovacuum_vacuum_scale_factor":"0.0","autovacuum_vacuum_threshold":"20000","autovacuum_vacuum_insert_scale_factor":"0.0","autovacuum_vacuum_insert_threshold":"10000"}'::jsonb THEN
    RAISE EXCEPTION 'ATOMIC_RECEIPT_MAINTENANCE_OPTIONS_NOT_INSTALLED';
  END IF;
END
$maintain$;
COMMIT;
