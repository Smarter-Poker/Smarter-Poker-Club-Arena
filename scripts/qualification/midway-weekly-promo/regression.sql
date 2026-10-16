DO $test$
DECLARE r jsonb; n int;
BEGIN
 PERFORM set_config('app.ledger_settlement','native-previous-weekly-round',true);
 INSERT INTO public.union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-12 07:00Z','2026-10-19 07:00Z','2026-10-19 09:00Z','complete',1,'{"success":true}');
 IF current_setting('app.ledger_settlement',true)<>'native-previous-weekly-round' THEN RAISE EXCEPTION 'parent ledger context not restored';END IF;
 SELECT result INTO r FROM public.union_weekly_horse_promo_runs;
 IF (r->>'eligible_wallets')::int<>4 OR (r->>'paid')::numeric<>50.01 OR (r->>'remaining_promo')::numeric<>50.02 THEN RAISE EXCEPTION 'wrong split %',r; END IF;
 IF (SELECT count(*) FROM public.union_weekly_horse_promo_recipients)<>4 OR
    (SELECT min(amount) FROM public.union_weekly_horse_promo_recipients)<>12.50 OR
    (SELECT max(amount) FROM public.union_weekly_horse_promo_recipients)<>12.51 THEN RAISE EXCEPTION 'per-club split';END IF;
 UPDATE public.union_accounting_runs SET status='complete' WHERE union_id='fade0000-0000-0000-0000-000000000001';
 IF (SELECT count(*) FROM public.union_weekly_horse_promo_recipients)<>4 THEN RAISE EXCEPTION 'duplicate paid';END IF;
 RAISE NOTICE 'PASS per-club eligibility, exact threshold, disabled/inactive/banned/departed/human exclusions, no duplicate';
END $test$;
-- Every receipt joins the original transaction and one authoritative ledger leg.
DO $test$
BEGIN
 IF EXISTS(SELECT 1 FROM union_weekly_horse_promo_recipients r
  LEFT JOIN chip_transactions t ON t.id=r.transaction_id
  LEFT JOIN chip_ledger l ON l.correlation_id=r.operation_id AND l.category='promo'
  WHERE t.amount IS DISTINCT FROM r.amount OR t.to_user_id IS DISTINCT FROM r.user_id
    OR t.club_id IS DISTINCT FROM r.club_id OR l.amount IS DISTINCT FROM r.amount
    OR l.from_type IS DISTINCT FROM 'union_wallet' OR l.to_type IS DISTINCT FROM 'player_wallet'
    OR l.from_label IS DISTINCT FROM 'union_wallets.promo_wallet' OR l.settlement_id IS DISTINCT FROM r.run_id::text) THEN RAISE EXCEPTION 'receipt/ledger mismatch %', (SELECT jsonb_agg(jsonb_build_object('operation',r.operation_id,'amount',r.amount,'ledger',to_jsonb(l))) FROM union_weekly_horse_promo_recipients r LEFT JOIN chip_ledger l ON l.correlation_id=r.operation_id); END IF;
 IF (SELECT count(*) FROM chip_ledger l JOIN union_weekly_horse_promo_recipients r ON r.operation_id=l.correlation_id)<>4 THEN RAISE EXCEPTION 'one leg per movement'; END IF;
 IF (SELECT sum(amount) FROM union_wallet_transactions WHERE tx_type='promo_disbursement')<>50.01 THEN RAISE EXCEPTION 'source receipt sum'; END IF;
 RAISE NOTICE 'PASS existing chip transactions, union wallet receipts and real journal legs';
END $test$;

-- A failure AFTER the first payment must undo every payment and completion.
BEGIN;
CREATE FUNCTION public.midway_fixture_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS(SELECT 1 FROM union_weekly_horse_promo_recipients WHERE run_id=NEW.run_id) THEN
 RAISE EXCEPTION 'fixture_late_receipt_failure';END IF;RETURN NEW;END$$;
CREATE TRIGGER midway_fixture_late_failure BEFORE INSERT ON union_weekly_horse_promo_recipients
 FOR EACH ROW EXECUTE FUNCTION public.midway_fixture_late_failure();
DO $test$
DECLARE before_promo numeric; before_tx bigint; before_ledger bigint; caught boolean:=false;
BEGIN
 SELECT promo_wallet INTO before_promo FROM union_wallets WHERE union_id='fade0000-0000-0000-0000-000000000001';
 SELECT count(*) INTO before_tx FROM chip_transactions; SELECT count(*) INTO before_ledger FROM chip_ledger;
 BEGIN
 INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 09:00Z','complete',1,'{"success":true}');
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'fixture_late_receipt_failure' THEN RAISE; END IF;caught:=true;END;
 IF NOT caught OR (SELECT count(*) FROM chip_transactions)<>before_tx OR (SELECT count(*) FROM chip_ledger)<>before_ledger
  OR (SELECT promo_wallet FROM union_wallets WHERE union_id='fade0000-0000-0000-0000-000000000001')<>before_promo
  OR EXISTS(SELECT FROM union_weekly_horse_promo_runs WHERE period_end='2026-10-26 07:00Z')
  OR EXISTS(SELECT FROM union_accounting_runs WHERE period_end='2026-10-26 07:00Z') THEN RAISE EXCEPTION 'partial payout escaped rollback'; END IF;
 RAISE NOTICE 'PASS late receipt failure rolls back all credits, debits, ledgers, receipts and weekly completion';
END $test$;
ROLLBACK;

BEGIN;
UPDATE club_members SET is_active=false WHERE membership_lifecycle_status='active' AND is_active IS TRUE AND club_id IN('a0000000-0000-0000-0000-000000000001','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','fade0000-0000-0000-0000-000000000001');
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 09:00Z','complete',1,'{"success":true}');
DO $$ BEGIN IF NOT EXISTS(SELECT FROM union_weekly_horse_promo_runs WHERE period_end='2026-10-26 07:00Z' AND paid=0 AND eligible_wallets=0 AND result->>'reason'='no_eligible_wallets')
 OR (SELECT promo_wallet FROM union_wallets WHERE union_id='fade0000-0000-0000-0000-000000000001')<>50.02 THEN RAISE EXCEPTION 'no eligible wallet spent money'; END IF; RAISE NOTICE 'PASS no eligible wallets retains all promo';END $$;
ROLLBACK;

-- Browser and service ACLs, and the original owner authorization, stay intact.
BEGIN;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',md5('midway-native-2')::uuid)::text,true);
SET LOCAL ROLE authenticated;
DO $$ DECLARE r jsonb; BEGIN
 r:=public.fn_promo_disburse('union','fade0000-0000-0000-0000-000000000001','player',md5('midway-native-2')::uuid,1,NULL,'a0000000-0000-0000-0000-000000000001',gen_random_uuid());
 IF r->>'success' IS DISTINCT FROM 'false' OR r->>'error' IS DISTINCT FROM 'Only The Union Owner May Disburse Union Promo' THEN RAISE EXCEPTION 'browser bypass %',r;END IF;
END $$;
ROLLBACK;
DO $$ BEGIN
 IF has_function_privilege('authenticated','fn_midway_weekly_horse_promo_close()','EXECUTE')
 OR has_table_privilege('authenticated','union_weekly_horse_promo_runs','SELECT')
 OR has_table_privilege('service_role','union_weekly_horse_promo_runs','INSERT')
 OR has_table_privilege('service_role','union_weekly_horse_promo_recipients','UPDATE')
 OR has_function_privilege('anon','fn_promo_disburse(text,uuid,text,uuid,numeric,text,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'financial surface opened';END IF;
 RAISE NOTICE 'PASS browser owner authorization and private receipt/trigger ACLs';END $$;

-- Historical and unfinished close events never spend current promo.
BEGIN;
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z','2026-10-12 09:00Z','complete',1,'{"success":true}'),
 ('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 09:00Z','running',1,'{"success":false,"chunk_committed":true}');
DO $$ BEGIN IF (SELECT count(*) FROM union_weekly_horse_promo_runs)<>1 THEN RAISE EXCEPTION 'historical/incomplete payout';END IF;RAISE NOTICE 'PASS historical and chunked unfinished closes do not pay';END $$;
ROLLBACK;

-- Two cents in the wallet makes a one-cent budget, apportioned without loss.
BEGIN;
SELECT fn_promo_disburse('union','fade0000-0000-0000-0000-000000000001','player',md5('midway-native-3')::uuid,50,NULL,'a0000000-0000-0000-0000-000000000001',gen_random_uuid());
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 09:00Z','complete',1,'{"success":true}');
DO $$ BEGIN IF NOT EXISTS(SELECT FROM union_weekly_horse_promo_runs WHERE period_end='2026-10-26 07:00Z' AND budget=.01 AND paid=.01 AND paid_wallets=1 AND eligible_wallets=3) THEN RAISE EXCEPTION 'tiny split failed';END IF;RAISE NOTICE 'PASS tiny budget, deterministic cent allocation and zero-size shares';END $$;
ROLLBACK;
BEGIN;
SELECT fn_promo_disburse('union','fade0000-0000-0000-0000-000000000001','player',md5('midway-native-3')::uuid,50.01,NULL,'a0000000-0000-0000-0000-000000000001',gen_random_uuid());
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 09:00Z','complete',1,'{"success":true}');
DO $$ BEGIN IF NOT EXISTS(SELECT FROM union_weekly_horse_promo_runs WHERE period_end='2026-10-26 07:00Z' AND budget=0 AND paid=0 AND result->>'reason'='no_distributable_chips') THEN RAISE EXCEPTION 'zero budget failed';END IF;RAISE NOTICE 'PASS indivisible half-cent retained';END $$;
ROLLBACK;
BEGIN;
INSERT INTO engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,updated_at,enforce_freeze,ownership_token)
 VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 minutes','native promo freeze',clock_timestamp(),true,gen_random_uuid());
DO $$ DECLARE caught boolean:=false;BEGIN
 IF NOT fn_platform_frozen() THEN RAISE EXCEPTION 'fixture freeze not active';END IF;
 BEGIN INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 09:00Z','complete',1,'{"success":true}');
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'midway_promo_platform_frozen' THEN RAISE;END IF;caught:=true;END;
 IF NOT caught OR (SELECT count(*) FROM union_weekly_horse_promo_runs)<>1 THEN RAISE EXCEPTION 'freeze bypass';END IF;
 RAISE NOTICE 'PASS actual platform freeze refuses new payout';END $$;
ROLLBACK;
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"authenticated"}',true);
DO $$ DECLARE caught boolean:=false;BEGIN
 BEGIN INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 09:00Z','complete',1,'{"success":true}');
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'midway_promo_service_required' THEN RAISE;END IF;caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'request authorization bypass';END IF;RAISE NOTICE 'PASS trigger refuses browser request context';END $$;
ROLLBACK;
BEGIN;
DO $$ DECLARE caught boolean:=false;BEGIN
 BEGIN INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 09:00Z','complete',1,'{"success":false}');
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'midway_promo_invalid_completed_week' THEN RAISE;END IF;caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'failed result accepted';END IF;RAISE NOTICE 'PASS failed close result cannot pay';END $$;
ROLLBACK;
