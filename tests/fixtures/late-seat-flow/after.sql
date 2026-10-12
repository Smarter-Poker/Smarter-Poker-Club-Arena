DO $test$
DECLARE n bigint; bad bigint; debit numeric; credit numeric; net numeric;
BEGIN
 SELECT count(*),count(*) FILTER(WHERE kind IS DISTINCT FROM 'cash_late_settlement' OR valid IS DISTINCT FROM true),sum(buyins),sum(cashouts),sum(cashouts-buyins)
 INTO n,bad,debit,credit,net FROM fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-06 15:33:00+00','2026-10-08 00:00:00+00');
 IF n<>31 OR bad<>0 OR debit IS DISTINCT FROM 125.70 OR credit IS DISTINCT FROM 339.89 OR net IS DISTINCT FROM 214.19 THEN
  RAISE EXCEPTION 'captured original quantity changed: %,%,%,%,%',n,bad,debit,credit,net;END IF;
 IF has_function_privilege('anon','fn_union_pnl_prove_late_settlement(uuid)','EXECUTE') OR has_function_privilege('authenticated','fn_union_pnl_prove_late_settlement(uuid)','EXECUTE')
  OR NOT has_function_privilege('service_role','fn_union_pnl_prove_late_settlement(uuid)','EXECUTE') THEN RAISE EXCEPTION 'proof access differs';END IF;
 RAISE NOTICE 'PASS all 31 original flows: 125.70 wallet debits / 339.89 wallet credits / +214.19 once';
 RAISE NOTICE 'PASS proof execute denies anon/authenticated and permits service_role';
END $test$;
