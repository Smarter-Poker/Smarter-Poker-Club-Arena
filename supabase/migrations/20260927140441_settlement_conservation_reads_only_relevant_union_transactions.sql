-- Record the independently qualified online settlement-conservation index.
-- The complete audit body, predicates, role authority and financial data remain
-- unchanged. Execute the maintained bounded online operation separately once,
-- inspect durable outcome, then use this short verification transaction.
-- @live-proof: select indexrelid::regclass,indisvalid,indisready,indislive from pg_index where indexrelid='public.idx_uwt_settlement_conservation'::regclass;
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = public, pg_temp;
DO $verify$
BEGIN
  IF to_regclass('public.idx_uwt_settlement_conservation') IS NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_CONSERVATION_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    JOIN pg_class tab ON tab.oid=i.indrelid JOIN pg_am am ON am.oid=ix.relam
    WHERE i.indexrelid='public.idx_uwt_settlement_conservation'::regclass
      AND i.indrelid='public.union_wallet_transactions'::regclass
      AND ix.relkind='i' AND tab.relkind='r' AND am.amname='btree'
      AND pg_get_userbyid(ix.relowner)='postgres' AND pg_get_userbyid(tab.relowner)='postgres'
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indnkeyatts=3 AND i.indnatts=5 AND i.indexprs IS NULL
      AND pg_get_indexdef(i.indexrelid,1,true)='tx_type'
      AND pg_get_indexdef(i.indexrelid,2,true)='union_id'
      AND pg_get_indexdef(i.indexrelid,3,true)='created_at'
      AND pg_get_indexdef(i.indexrelid,4,true)='club_id'
      AND pg_get_indexdef(i.indexrelid,5,true)='amount'
      AND i.indoption::text='0 0 0'
      AND NOT EXISTS (SELECT 1 FROM generate_series(0,2) n
        WHERE i.indcollation[n] IS DISTINCT FROM (SELECT attcollation FROM pg_attribute WHERE attrelid=i.indrelid AND attnum=i.indkey[n])
           OR i.indclass[n] IS DISTINCT FROM (SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname=(ARRAY['text_ops','uuid_ops','timestamptz_ops'])[n+1] AND opcmethod=ix.relam))
      AND pg_get_expr(i.indpred,i.indrelid)='(tx_type = ANY (ARRAY[''player_pnl_collect''::text, ''player_pnl_pay''::text, ''settlement_hold''::text]))'
  ) THEN
    RAISE EXCEPTION 'SETTLEMENT_CONSERVATION_INDEX_CONTRACT_CHANGED' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef(to_regprocedure('public.fn_settlement_conservation_check()'))) IS DISTINCT FROM '9502e93b3726e7e0c04e0e63ad8ceba5' THEN
    RAISE EXCEPTION 'SETTLEMENT_CONSERVATION_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
END
$verify$;
COMMIT;
