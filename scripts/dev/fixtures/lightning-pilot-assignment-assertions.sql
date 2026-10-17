
-- Explicit native financial boundary, AFTER production-preimage installation.
-- The production normal authenticated wrapper itself remains unchanged.
CREATE OR REPLACE FUNCTION public.fn_ca_unregister_tournament_player_exact(p_tournament_id uuid,p_user_id uuid,p_expected_table_id uuid DEFAULT NULL::uuid,p_description text DEFAULT NULL::text,p_request_id uuid DEFAULT NULL::uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $boundary$
DECLARE r tournament_players%ROWTYPE;
BEGIN
 SELECT * INTO r FROM tournament_players WHERE tournament_id=p_tournament_id AND user_id=p_user_id FOR UPDATE;
 DELETE FROM tournament_players WHERE id=r.id;
 INSERT INTO witness.calls VALUES('withdraw',false);
 RETURN jsonb_build_object('ok',true,'registration_id',CASE WHEN current_setting('witness.wrong_receipt',true)='true' THEN '50000000-0000-0000-0000-000000000099'::uuid ELSE r.id END,'request_id',p_request_id,'refunded_chips',CASE WHEN current_setting('witness.bad_refund',true)='true' THEN 1 ELSE 0 END,'returned_ticket_value',0,'fees_reversed',0);
END $boundary$;
\set ON_ERROR_STOP on
SELECT set_config('request.jwt.claim.sub','2d1cd6c3-5700-4af9-a271-d4863fdab20d',false);
SELECT set_config('witness.live','true',false);
DO $$ BEGIN
 IF (fn_lightning_pilot_assignment_status()->>'active')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'migration activated assignment'; END IF;
 IF EXISTS((SELECT oid::regprocedure::text,proowner,proacl,prosecdef,provolatile,proconfig FROM pg_proc WHERE oid IN('fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure,'fn_seat_horse_in_seat_first_game(uuid,uuid)'::regprocedure)) EXCEPT SELECT * FROM witness.catalog_before) THEN RAISE EXCEPTION 'original catalog changed'; END IF;
END $$;
SELECT fn_lightning_pilot_assignment_set(true,'70000000-0000-0000-0000-000000000001','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native exact assignment');
SELECT witness.assert_refused();
DO $$ BEGIN
 IF fn_register_horse_for_tournament('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3',true)->>'reason' IS DISTINCT FROM 'lightning_pilot_assigned' THEN RAISE EXCEPTION 'three arg bypass'; END IF;
 IF (SELECT count(*) FROM lightning_pilot_assignment_receipts)<>1 THEN RAISE EXCEPTION 'receipt missing'; END IF;
 PERFORM fn_lightning_pilot_assignment_set(true,'70000000-0000-0000-0000-000000000001','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native exact assignment');
 IF (SELECT count(*) FROM lightning_pilot_assignment_receipts)<>1 THEN RAISE EXCEPTION 'duplicate receipt'; END IF;
 BEGIN
  PERFORM fn_lightning_pilot_assignment_set(false,'70000000-0000-0000-0000-000000000001','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native exact assignment');
  RAISE EXCEPTION 'collision accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM fn_lightning_pilot_assignment_set(NULL,'70000000-0000-0000-0000-000000000010','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native exact assignment');
  RAISE EXCEPTION 'unknown accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM fn_lightning_pilot_assignment_set(true,'70000000-0000-0000-0000-000000000011','wrong',fn_lightning_pilot_assignment_players(),'native exact assignment');
  RAISE EXCEPTION 'manifest accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
TRUNCATE witness.calls;
-- A genuine existing entry and a live chair continue through unchanged owners.
INSERT INTO tournament_players(tournament_id,user_id,status) VALUES('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3','playing');
SELECT fn_register_horse_for_tournament('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3');
SELECT fn_seat_horse_in_seat_first_game('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3');
DELETE FROM tournament_players;
INSERT INTO tables VALUES('60000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001');
INSERT INTO table_seats(table_id,user_id) VALUES('60000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3');
SELECT fn_seat_horse_in_seat_first_game('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3');
DELETE FROM table_seats;
-- Paid proof boundary valid for this holder/target only; never wallet fallback.
INSERT INTO witness.ticket VALUES('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3',true,false);
DO $$ BEGIN
 IF (fn_register_horse_for_tournament('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3')->>'wallet_allowed')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'ticket wallet fallback'; END IF;
END $$;
UPDATE witness.ticket SET cashier=true;
DO $$ BEGIN
 IF (fn_register_horse_for_tournament('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3')->>'wallet_allowed')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'cashier ticket wallet fallback'; END IF;
END $$;
UPDATE witness.ticket SET valid=false;
SELECT witness.assert_refused();
TRUNCATE witness.ticket;
SELECT fn_register_horse_for_tournament('80000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000099');
DO $$ BEGIN IF (SELECT count(*) FROM witness.calls)<>6 THEN RAISE EXCEPTION 'delegate count %',(SELECT count(*) FROM witness.calls); END IF; END $$;
SELECT fn_lightning_pilot_assignment_set(false,'70000000-0000-0000-0000-000000000002','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native explicit off');
SELECT fn_register_horse_for_tournament('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3');
BEGIN;
SELECT fn_lightning_pilot_assignment_set(true,'70000000-0000-0000-0000-000000000003','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native rollback test');
ROLLBACK;
DO $$ BEGIN
 IF (SELECT active FROM lightning_pilot_assignment) OR EXISTS(SELECT 1 FROM lightning_pilot_assignment_receipts WHERE request_id='70000000-0000-0000-0000-000000000003') THEN RAISE EXCEPTION 'interruption persisted'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','90000000-0000-0000-0000-000000000099',false);
DO $$ BEGIN BEGIN
 PERFORM fn_lightning_pilot_assignment_set(true,'70000000-0000-0000-0000-000000000004','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native foreign actor');
 RAISE EXCEPTION 'foreign actor accepted';
EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$;
SELECT set_config('request.jwt.claim.sub','2d1cd6c3-5700-4af9-a271-d4863fdab20d',false);
SELECT set_config('witness.live','false',false);
DO $$ BEGIN BEGIN
 PERFORM fn_lightning_pilot_assignment_set(true,'70000000-0000-0000-0000-000000000004','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native dead session');
 RAISE EXCEPTION 'dead session accepted';
EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$;
SELECT set_config('witness.live','true',false);
UPDATE cash_games SET template_name='classic';
DO $$ BEGIN BEGIN
 PERFORM fn_lightning_pilot_assignment_set(true,'70000000-0000-0000-0000-000000000005','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native target drift');
 RAISE EXCEPTION 'target drift accepted';
EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END; END $$;
-- Explicit off remains possible when current target metadata has drifted.
SELECT fn_lightning_pilot_assignment_set(false,'70000000-0000-0000-0000-000000000006','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native explicit restore');
DO $$ BEGIN
 IF has_function_privilege('service_role','fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)','EXECUTE') OR has_function_privilege('anon','fn_lightning_pilot_assignment_status()','EXECUTE') THEN RAISE EXCEPTION 'ACL broadened'; END IF;
END $$;


INSERT INTO witness.refund_receipt VALUES('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3','70000000-0000-0000-0000-000000000020','{"ok":true,"registration_id":"60000000-0000-0000-0000-000000000020","request_id":"70000000-0000-0000-0000-000000000020","refunded_chips":0}');
DO $$ BEGIN
 IF fn_lightning_pilot_withdrawal_receipt('0097309f-2864-4d09-b02b-56bca012a9c3','80000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000020','70000000-0000-0000-0000-000000000020')->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'owner receipt missing after off'; END IF;
 IF fn_lightning_pilot_withdrawal_receipt('0097309f-2864-4d09-b02b-56bca012a9c3','80000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000099','70000000-0000-0000-0000-000000000020') IS NOT NULL THEN RAISE EXCEPTION 'wrong registration receipt'; END IF;
 BEGIN
 PERFORM fn_lightning_pilot_withdrawal_receipt('90000000-0000-0000-0000-000000000099','80000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000020','70000000-0000-0000-0000-000000000020');
 RAISE EXCEPTION 'foreign player receipt'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT fn_lightning_pilot_assignment_status();
SELECT fn_lightning_pilot_withdrawal_receipt('0097309f-2864-4d09-b02b-56bca012a9c3','80000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000020','70000000-0000-0000-0000-000000000020');
RESET ROLE;
SELECT set_config('request.jwt.claim.role','authenticated',false);
DO $$ BEGIN
 IF has_function_privilege('service_role','fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'underlying receipt widened'; END IF;
END $$;

-- Atomic expected identity prevents the caller's stale free-A proof from
-- withdrawing a replacement paid-B lifecycle.
SELECT set_config('request.jwt.claim.sub','2d1cd6c3-5700-4af9-a271-d4863fdab20d',false);
UPDATE cash_games SET template_name=ruleset_snapshot->>'template';
SELECT fn_lightning_pilot_assignment_set(true,'70000000-0000-0000-0000-000000000041','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native atomic withdrawal');
SELECT set_config('request.jwt.claim.sub','0097309f-2864-4d09-b02b-56bca012a9c3',false);
INSERT INTO tournament_players(id,tournament_id,user_id,status) VALUES('50000000-0000-0000-0000-000000000002','80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3','registered');
DO $$ DECLARE n bigint; BEGIN
 SELECT count(*) INTO n FROM witness.calls WHERE kind='withdraw';
 BEGIN
 PERFORM fn_lightning_pilot_withdraw_zero('80000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000040');
 RAISE EXCEPTION 'stale lifecycle accepted'; EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 IF (SELECT count(*) FROM witness.calls WHERE kind='withdraw')<>n OR NOT EXISTS(SELECT 1 FROM tournament_players WHERE id='50000000-0000-0000-0000-000000000002') THEN RAISE EXCEPTION 'replacement lifecycle touched'; END IF;
END $$;
-- Even the exact lifecycle cannot withdraw paid/seat/started contracts.
INSERT INTO wallet_transactions VALUES('0097309f-2864-4d09-b02b-56bca012a9c3','80000000-0000-0000-0000-000000000001','debit',10);
DO $$ BEGIN BEGIN
 PERFORM fn_lightning_pilot_withdraw_zero('80000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000042');
 RAISE EXCEPTION 'paid withdrawal accepted'; EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END; END $$;
TRUNCATE wallet_transactions;
SELECT set_config('witness.bad_refund','true',false);
DO $$ DECLARE n bigint; BEGIN
 SELECT count(*) INTO n FROM witness.calls WHERE kind='withdraw';
 BEGIN
 PERFORM fn_lightning_pilot_withdraw_zero('80000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000043');
 RAISE EXCEPTION 'nonzero delegate refund committed'; EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 IF NOT EXISTS(SELECT 1 FROM tournament_players WHERE id='50000000-0000-0000-0000-000000000002') OR (SELECT count(*) FROM witness.calls WHERE kind='withdraw')<>n THEN RAISE EXCEPTION 'failed receipt did not rollback owner'; END IF;
END $$;
SELECT set_config('witness.bad_refund','false',false);
SELECT set_config('witness.wrong_receipt','true',false);
DO $$ DECLARE n bigint; BEGIN
 SELECT count(*) INTO n FROM witness.calls WHERE kind='withdraw';
 BEGIN
 PERFORM fn_lightning_pilot_withdraw_zero('80000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000043');
 RAISE EXCEPTION 'wrong delegate receipt committed'; EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 IF NOT EXISTS(SELECT 1 FROM tournament_players WHERE id='50000000-0000-0000-0000-000000000002') OR (SELECT count(*) FROM witness.calls WHERE kind='withdraw')<>n THEN RAISE EXCEPTION 'wrong receipt did not rollback owner'; END IF;
END $$;
SELECT set_config('witness.wrong_receipt','false',false);
DO $$ BEGIN
 IF fn_lightning_pilot_withdraw_zero('80000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000043')->>'registration_id' IS DISTINCT FROM '50000000-0000-0000-0000-000000000002' THEN RAISE EXCEPTION 'exact zero withdrawal failed'; END IF;
 IF EXISTS(SELECT 1 FROM tournament_players WHERE id='50000000-0000-0000-0000-000000000002') THEN RAISE EXCEPTION 'normal withdrawal not reached'; END IF;
 IF has_function_privilege('service_role','fn_lightning_pilot_withdraw_zero(uuid,uuid,uuid)','EXECUTE') OR has_function_privilege('anon','fn_lightning_pilot_withdraw_zero(uuid,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'withdraw ACL broad'; END IF;
END $$;

-- Diamond zero custody is its own maintained normal owner boundary.
CREATE OR REPLACE FUNCTION fn_poker_diamond_tournament(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('witness.diamond',true),'false')='true'$$;
CREATE OR REPLACE FUNCTION fn_poker_diamond_tournament_unregister(p_tournament_id uuid,p_user_id uuid,p_request_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $boundary$
DECLARE r tournament_players%ROWTYPE; cid uuid;
BEGIN
 SELECT * INTO r FROM tournament_players WHERE tournament_id=p_tournament_id AND user_id=p_user_id FOR UPDATE;
 UPDATE poker_diamond_custody SET state='released' WHERE target_id=p_tournament_id AND user_id=p_user_id RETURNING id INTO cid;
 DELETE FROM tournament_players WHERE id=r.id;
 RETURN jsonb_build_object('ok',true,'registration_id',r.id,'request_id',p_request_id,'refunded_diamonds',0,'custody_id',cid);
END $boundary$;
SELECT set_config('witness.diamond','true',false);
INSERT INTO tournament_players(id,tournament_id,user_id,status) VALUES('50000000-0000-0000-0000-000000000003','80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3','registered');
INSERT INTO poker_diamond_custody VALUES('40000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3','80000000-0000-0000-0000-000000000001','tournament_entry','active',1,NULL,'entry:50000000-0000-0000-0000-000000000003');
DO $$ BEGIN BEGIN
 PERFORM fn_lightning_pilot_withdraw_zero('80000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000003','70000000-0000-0000-0000-000000000045');
 RAISE EXCEPTION 'positive Diamond custody withdrew'; EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END; END $$;
UPDATE poker_diamond_custody SET balance=0;
DO $$ BEGIN
 IF fn_lightning_pilot_withdraw_zero('80000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000003','70000000-0000-0000-0000-000000000045')->>'refunded_diamonds' IS DISTINCT FROM '0' THEN RAISE EXCEPTION 'zero Diamond owner not reached'; END IF;
 IF (SELECT state FROM poker_diamond_custody WHERE id='40000000-0000-0000-0000-000000000001')<>'released' THEN RAISE EXCEPTION 'free custody not released'; END IF;
END $$;
SELECT set_config('witness.diamond','false',false);
SELECT set_config('request.jwt.claim.sub','2d1cd6c3-5700-4af9-a271-d4863fdab20d',false);
SELECT fn_lightning_pilot_assignment_set(false,'70000000-0000-0000-0000-000000000044','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native atomic cleanup');
