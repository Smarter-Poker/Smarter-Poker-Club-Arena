-- The early dealer admission added in PR #8093 reads these four receipt
-- columns, but the original capacity migration revoked ALL from service_role.
-- Nightly 10K table 196af8ef waited seated from 00:20 until 00:45 on Oct 27;
-- the incident window has 42501 failures for this receipt read. Restore only
-- the read used by that original admission. Mutation remains behind the
-- existing service-only acknowledgement RPC. No player, seat or money writes.
-- @live-proof: (SELECT bool_and(has_column_privilege('service_role','public.tournament_capacity_table_receipts',c,'SELECT')) FROM unnest(ARRAY['table_id','tournament_id','created_at','manager_admitted_at']) c)
-- @live-proof: (SELECT NOT has_table_privilege('anon','public.tournament_capacity_table_receipts','SELECT') AND NOT has_table_privilege('authenticated','public.tournament_capacity_table_receipts','SELECT') AND NOT has_table_privilege('service_role','public.tournament_capacity_table_receipts','UPDATE'))
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $precondition$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.tournament_capacity_table_receipts'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'CAPACITY_RECEIPT_RLS_REQUIRED';
  END IF;
END;
$precondition$;

GRANT SELECT (table_id, tournament_id, created_at, manager_admitted_at)
  ON TABLE public.tournament_capacity_table_receipts TO service_role;

DO $assert$
DECLARE
  v_role text;
  v_column text;
BEGIN
  FOREACH v_column IN ARRAY ARRAY['table_id','tournament_id','created_at','manager_admitted_at'] LOOP
    IF NOT has_column_privilege('service_role','public.tournament_capacity_table_receipts',v_column,'SELECT') THEN
      RAISE EXCEPTION 'CAPACITY_RECEIPT_ENGINE_READ_REQUIRED';
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH v_column IN ARRAY ARRAY['table_id','tournament_id','manager_wake_id','created_at','manager_admitted_at','updated_at'] LOOP
      IF has_column_privilege(v_role,'public.tournament_capacity_table_receipts',v_column,'SELECT') THEN
        RAISE EXCEPTION 'CAPACITY_RECEIPT_BROWSER_READ_REFUSED';
      END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('service_role','public.tournament_capacity_table_receipts','INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_column_privilege('service_role','public.tournament_capacity_table_receipts','manager_wake_id','SELECT')
     OR has_column_privilege('service_role','public.tournament_capacity_table_receipts','updated_at','SELECT') THEN
    RAISE EXCEPTION 'CAPACITY_RECEIPT_GRANT_TOO_WIDE';
  END IF;
END;
$assert$;
COMMIT;
