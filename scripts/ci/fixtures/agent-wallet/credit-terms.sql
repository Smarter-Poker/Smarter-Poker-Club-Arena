BEGIN;
UPDATE agents SET is_prepaid=false,credit_limit=1000 WHERE id=1;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM agents WHERE id=1 AND NOT is_prepaid AND credit_limit=1000) THEN RAISE EXCEPTION 'credit terms did not persist'; END IF; END $$;
UPDATE agents SET credit_used=400 WHERE id=1;
DO $$ BEGIN
 BEGIN UPDATE agents SET credit_limit=399 WHERE id=1; RAISE EXCEPTION 'debt reduction unexpectedly allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE agents SET is_prepaid=true,credit_limit=0 WHERE id=1; RAISE EXCEPTION 'debt erased by prepaid'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE agents SET credit_limit='NaN' WHERE id=1; RAISE EXCEPTION 'NaN allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO agents(id,is_prepaid,credit_limit,credit_used) VALUES(2,false,0,0); RAISE EXCEPTION 'zero credit allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO agents(id,is_prepaid,credit_limit,credit_used) VALUES(2,true,500,0); RAISE EXCEPTION 'prepaid line allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE agents SET credit_used=0 WHERE id=1;
UPDATE agents SET is_prepaid=true,credit_limit=0 WHERE id=1;
ROLLBACK;
SELECT 'credit terms round trip and debt guards passed' AS result;
