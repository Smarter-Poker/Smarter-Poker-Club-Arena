BEGIN;
SELECT credit_agent_commission_from_rake('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000900',100,'rake_settlement','00000000-0000-4000-8000-000000000799');
SELECT credit_agent_commission_from_rake('00000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-000000000900',100,'rake_settlement','00000000-0000-4000-8000-000000000799');
DO $$ BEGIN
 IF (SELECT count(*)<>2 OR sum(amount)<>62.50 FROM agent_commissions) THEN RAISE EXCEPTION 'Original defect not reproduced'; END IF;
 IF EXISTS(SELECT 1 FROM agent_commissions WHERE user_id='00000000-0000-4000-8000-000000000103') THEN RAISE EXCEPTION 'Original unexpectedly accrues grandparent'; END IF;
 RAISE NOTICE 'BEFORE PROOF: two contributors with three uplines produce only two rows totaling 62.50; super agent receives zero';
END $$;
ROLLBACK;
