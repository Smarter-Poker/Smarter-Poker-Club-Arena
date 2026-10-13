DO $test$
BEGIN
 IF (SELECT count(*) FROM fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-06 15:33:00+00','2026-10-08 00:00:00+00') WHERE kind='unsupported' AND valid=false)<>31 THEN
  RAISE EXCEPTION 'exact original-flow predecessor no longer reproduces 31 unsupported flows';END IF;
 RAISE NOTICE 'PASS fail-before: exact installed reader rejects all 31 captured original late settlements';
END $test$;
