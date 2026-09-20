-- Exact live predecessors captured read-only after the installed ECO/inventory
-- successors. Refuse concurrent source, owner or ACL drift before any DDL.
DO $installed_preconditions$
DECLARE expected record; actual record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('fn_accounting_union_eco_capture()','9e1a4ddba6c70088805c09383da365b5','{postgres=X/postgres}','postgres'),
  ('fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])','e683367f367422c00539a38f9600858e','{postgres=X/postgres}','postgres'),
  ('fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)','26ba834fa272f040ab6edae0a4f8bf58','{postgres=X/postgres}','postgres'),
  ('fn_process_weekly_accounting_scope(uuid,uuid)','f3b8fcb98bd23b4eb767b5dada37852e','{postgres=X/postgres}','postgres'),
  ('fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)','7344f38c069f5d85332c09c33aa49c6a','{postgres=X/postgres}','postgres'),
  ('fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)','7626aff917e8fba3cb6f54af51905dc0','{postgres=X/postgres}','postgres'),
  ('fn_union_eco_adjustment(uuid,timestamp with time zone,timestamp with time zone)','a30873186aed162044712b5f80ef2f9b','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_eco_record(uuid,timestamp with time zone,timestamp with time zone,uuid)','a6c4fd4824525c73e360410d8ce5980c','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_eco_terms_evidence(uuid,timestamp with time zone,timestamp with time zone)','6715f9e156ae6296e02d060d3b6dfbf1','{postgres=X/postgres}','postgres'),
  ('fn_union_pnl_all_clubs(uuid,timestamp with time zone,timestamp with time zone,boolean)','f01c3c66265fddd7ce88962ad0bb13f9','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_pnl_baseline(uuid,timestamp with time zone)','45ad9f400f7ba63a1e788ccdab55cc81','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_pnl_cash_by_club(uuid,timestamp with time zone,timestamp with time zone,boolean)','e8d46ba1a3753c34818860ddfe57e242','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)','9f4dfe20444ddf1b89e459b669bdff7b','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_pnl_inventory_observe()','abc1eb57d79544e11589a348a499c426','{postgres=X/postgres}','postgres'),
  ('fn_union_reconciliation_report(uuid,timestamp with time zone,timestamp with time zone)','630e87c9842a423e6a5198551623dec0','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_settle_player_pnl(uuid,timestamp with time zone,timestamp with time zone,boolean)','38a7efa81411b06b289adff5b144c643','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)','42d975cb30c4185dbf58b57f840296a7','{postgres=X/postgres}','postgres')
 ) AS v(signature,definition_md5,acl,owner_name)
 LOOP
  SELECT md5(pg_get_functiondef(p.oid)) AS definition_md5,p.proacl::text AS acl,
    pg_get_userbyid(p.proowner) AS owner_name INTO actual
  FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||expected.signature);
  IF NOT FOUND OR actual.definition_md5 IS DISTINCT FROM expected.definition_md5
    OR actual.acl IS DISTINCT FROM expected.acl OR actual.owner_name IS DISTINCT FROM expected.owner_name THEN
   RAISE EXCEPTION 'weekly_original_predecessor_drift:%',expected.signature USING ERRCODE='55000';
  END IF;
 END LOOP;
END $installed_preconditions$;
