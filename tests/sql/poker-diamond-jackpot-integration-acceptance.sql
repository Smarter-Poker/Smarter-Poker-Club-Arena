SELECT fixture_assert(NOT fn_ca_diamond_economic_on('bbj_enabled'),'compatibility leaves the jackpot closed');
SELECT fixture_assert(NOT has_function_privilege('authenticated','fn_ca_arena_diamonds()','EXECUTE')
 AND NOT has_function_privilege('anon','fn_ca_arena_diamonds()','EXECUTE')
 AND has_function_privilege('service_role','fn_ca_arena_diamonds()','EXECUTE')
 AND has_function_privilege('authenticated','fn_bbj_pool_for_club(uuid)','EXECUTE')
 AND has_function_privilege('service_role','fn_bbj_pool_for_club(uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','fn_bbj_pool_for_club(uuid)','EXECUTE'),
 'replacement arena float and pool feed retain their exact authenticated service and anonymous ACLs');
SELECT fixture_assert(
 NOT has_function_privilege('anon','fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)','EXECUTE')
 AND NOT has_function_privilege('authenticated','fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)','EXECUTE')
 AND NOT has_function_privilege('service_role','fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)','EXECUTE')
 AND has_function_privilege('postgres','fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)','EXECUTE')
 AND NOT has_function_privilege('anon','fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])','EXECUTE')
 AND NOT has_function_privilege('authenticated','fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])','EXECUTE')
 AND NOT has_function_privilege('service_role','fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])','EXECUTE')
 AND has_function_privilege('postgres','fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])','EXECUTE')
 AND has_function_privilege('service_role','fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)','EXECUTE')
 AND NOT has_function_privilege('authenticated','fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)','EXECUTE')
 AND NOT has_function_privilege('anon','fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)','EXECUTE'),
 'direct Diamond settler and Main payer are owner only while accepted-hand outer admits service_role only');
SELECT fixture_assert((fixture_jackpot_commit(1100002)->>'success')::boolean,'compatibility accepts a zero-fee hand through the real wrapper');
INSERT INTO ca_diamond_economics(name,scope,value_text,units,approved_quote,approved_on,basis,recorded_by)
 VALUES('bbj_enabled','all','yes','boolean','private fixture activation only',CURRENT_DATE,
 'isolated acceptance fixture','fixture');
SELECT fixture_assert((fixture_jackpot_commit(1100003,300)->>'success')::boolean,'enabled scheduled drop commits through the real wrapper');
CREATE FUNCTION fixture_jackpot_snapshot() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM profiles t),
 'accrual',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ca_diamond_rake_accrual t),
 'custody',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM poker_diamond_custody t),
 'lots',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM diamond_purchase_lots t),
 'seats',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM table_seats t),
 'journal',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM diamond_transactions t),
 'credit_keys',(SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM wallet_credit_idempotency t),
 'reservations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY custody_id,lot_id) FROM poker_diamond_lot_reservations t),
 'pools',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM poker_diamond_jackpot_pools t),
 'movements',(SELECT jsonb_agg(to_jsonb(t) ORDER BY request_id) FROM poker_diamond_movements t),
 'register',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ca_mint_ledger t),
 'receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY hand_number) FROM poker_diamond_hand_receipts t),
 'commits',(SELECT jsonb_agg(to_jsonb(t) ORDER BY hand_number) FROM hand_atomic_commits t),
 'history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY hand_number) FROM hand_history t),
 'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM poker_diamond_jackpot_ledger t),
 'hits',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM poker_diamond_jackpot_hits t),
 'notifications',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM notifications t));
$$;
CREATE FUNCTION fixture_jackpot_rejected(h bigint,amount numeric,flop boolean,boards boolean,expected text,kind text DEFAULT 'none',rake_fee numeric DEFAULT 0)
 RETURNS void LANGUAGE plpgsql AS $$
DECLARE before jsonb:=fixture_jackpot_snapshot(); r jsonb; failed boolean:=false;
BEGIN
 BEGIN r:=fixture_jackpot_commit(h,amount,flop,boards,kind,rake_fee);
  failed:=r->>'success'='false' AND r::text LIKE '%'||expected||'%';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%'||expected||'%' THEN RAISE; END IF; failed:=true; END;
 PERFORM fixture_assert(failed,'refuses '||expected);
 PERFORM fixture_assert(before=fixture_jackpot_snapshot(),'refusal rolls back every observed financial/accepted row');
END $$;
SELECT fixture_jackpot_rejected(1100004,299,true,false,'schedule');
SELECT fixture_jackpot_rejected(1100004,300.5,true,false,'whole');
SELECT fixture_jackpot_rejected(1100004,300,false,false,'schedule');
SELECT fixture_jackpot_rejected(1100004,300,true,true,'schedule');
SELECT fixture_assert((fixture_jackpot_commit(1100004,0,false,false)->>'success')::boolean,
 'no flop means zero jackpot drop');
SELECT fixture_assert((fixture_jackpot_commit(1100005,0,true,true)->>'success')::boolean,
 'double board means zero jackpot drop');
CREATE TEMP TABLE fixture_main_request AS SELECT fixture_jackpot_request(1100006,300,true,false,'main') AS q;
CREATE TEMP TABLE fixture_main_before AS SELECT fixture_jackpot_snapshot() AS snapshot;
CREATE TEMP TABLE fixture_main_result AS SELECT fixture_jackpot_commit(1100006,300,true,false,'main') AS receipt;
SELECT fixture_assert((SELECT receipt->>'success'='true' AND receipt#>>'{diamond_jackpot_receipt,paid}'='true'
 FROM fixture_main_result),'main jackpot is paid in the accepted-hand transaction');
SELECT fixture_assert((SELECT receipt#>>'{diamond_jackpot_receipt,total}'='255'
 AND receipt#>>'{diamond_jackpot_receipt,loser,share}'='130'
 AND receipt#>>'{diamond_jackpot_receipt,winner,share}'='63'
 AND receipt#>>'{diamond_jackpot_receipt,perPlayerShare}'='31' FROM fixture_main_result),
 '255 announced Diamonds floor to 130 bad-beat 63 winner and 31 per remaining player');
SELECT fixture_assert((SELECT sum((leg->>'amount')::bigint)=(r.receipt#>>'{diamond_jackpot_receipt,total}')::bigint
 FROM fixture_main_result r,LATERAL jsonb_array_elements(r.receipt#>'{diamond_jackpot_receipt,payment,legs}') leg
 GROUP BY r.receipt),'whole payout legs equal the announced total exactly');
SELECT fixture_assert((SELECT count(*)=4 FROM poker_diamond_jackpot_ledger WHERE kind='payout' AND hand_number=1100006),
 'all dealt recipients including the horse receive real wallet credits');
SELECT fixture_assert((SELECT count(*)=4 FROM notifications WHERE data->>'hand_number'='1100006'),
 'paid recipients receive durable notifications');
CREATE TEMP TABLE fixture_replay_before AS SELECT fixture_jackpot_snapshot() AS snapshot;
CREATE TEMP TABLE fixture_replay AS SELECT fn_ca_commit_hand_settlement(
 '30000000-0000-0000-0000-000000000002',1100006,q->'stacks',0,300,NULL,0,q->'row','[]'::jsonb,
 'fixture-jackpot','90000000-0000-0000-0000-000000000001',q->'obligations') AS receipt FROM fixture_main_request;
SELECT fixture_assert((SELECT receipt#>'{diamond_jackpot_receipt}'=(SELECT receipt#>'{diamond_jackpot_receipt}' FROM fixture_main_result)
 FROM fixture_replay),'replay returns the identical immutable jackpot receipt');
SELECT fixture_assert((SELECT snapshot=fixture_jackpot_snapshot() FROM fixture_replay_before),
 'replay changes no wallet lot seat receipt ledger notification or accepted row');
SELECT fixture_assert((SELECT difference=0 FROM fn_ca_diamond_register_vs_supply()),
 'real wallet payouts and player-side drop conserve registered Diamond supply');
-- With little funding the Mini verdict is retained without promising a payment.
SELECT fixture_assert((fixture_jackpot_commit(1100007,300,true,false,'mini')#>>'{diamond_jackpot_receipt,paid}')='false',
 'unfunded Mini reserve never pays below its floor');
-- Fund the backup using real accepted drops, with no ledger/balance patch.
DO $$ DECLARE h bigint; r jsonb; BEGIN FOR h IN 1100100..1100185 LOOP
 r:=fixture_jackpot_commit(h,300,true,false,'none');
 IF r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'funding hand failed: %',r; END IF;
 END LOOP; END $$;
SELECT fixture_assert(fn_poker_diamond_jackpot_bank(
 fn_poker_diamond_jackpot_pool_for_table('30000000-0000-0000-0000-000000000002'),'backup')>=6500,
 'Mini bank funded exclusively by accepted player drops');
INSERT INTO user_notification_preferences(user_id,diamond_rewards)
 VALUES('11000000-0000-0000-0000-000000000004',false);
CREATE TEMP TABLE fixture_mini_result AS SELECT fixture_jackpot_commit(1100200,300,true,false,'mini') AS receipt;
SELECT fixture_assert((SELECT receipt->>'success'='true' AND receipt#>>'{diamond_jackpot_receipt,paid}'='true'
 AND receipt#>>'{diamond_jackpot_receipt,total}'='1500' FROM fixture_mini_result),
 'funded Mini pays its independent whole Diamond price atomically');
SELECT fixture_assert(fn_poker_diamond_jackpot_bank(
 fn_poker_diamond_jackpot_pool_for_table('30000000-0000-0000-0000-000000000002'),'backup')>=5000,
 'funded Mini retains the reserve floor');
SELECT fixture_assert((SELECT count(*)=3 FROM notifications WHERE data->>'hand_number'='1100200'),
 'Diamond notification opt out is honored without excluding the horse payout');
SELECT fixture_assert((SELECT difference=0 FROM fn_ca_diamond_register_vs_supply()),
 'funded Mini and all preceding accepted drops conserve total supply');
-- A later recipient notification failure must undo earlier real wallet credits,
-- every custody/lot update, the drop, history and accepted commit together.
CREATE FUNCTION fixture_jackpot_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.user_id='11000000-0000-0000-0000-000000000002' THEN
 RAISE EXCEPTION 'fixture_late_jackpot_failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER fixture_jackpot_late_failure BEFORE INSERT ON notifications
 FOR EACH ROW EXECUTE FUNCTION fixture_jackpot_late_failure();
SELECT fixture_jackpot_rejected(1100201,300,true,false,'fixture_late_jackpot_failure','main');
DROP TRIGGER fixture_jackpot_late_failure ON notifications;
SELECT fixture_assert((fixture_jackpot_commit(1100201,300,true,false,'main')->>'success')::boolean,
 'same hand can succeed after a fully rolled-back late failure');
SELECT fixture_assert(NOT has_function_privilege('authenticated',
 'fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)','EXECUTE')
 AND NOT has_function_privilege('anon',
 'fn_poker_diamond_jackpot_hand_detail(uuid)','EXECUTE')
 AND NOT has_function_privilege('service_role',
 'fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])','EXECUTE'),
 'client roles cannot settle or bypass acceptance and anonymous callers cannot read details');
SELECT set_config('test.jackpot_id',(SELECT id::text FROM poker_diamond_jackpot_hits WHERE hand_number=1100006),false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SET ROLE authenticated;
SELECT fixture_assert(fn_poker_diamond_jackpot_hand_detail(current_setting('test.jackpot_id')::uuid)->>'handAvailable'='true',
 'authenticated stranger can read the awarded hand rundown');
SELECT fixture_assert((SELECT count(*)=2 FROM jsonb_array_elements(
 fn_poker_diamond_jackpot_hand_detail(current_setting('test.jackpot_id')::uuid)->'players') p
 WHERE p->'cards' IS DISTINCT FROM 'null'::jsonb),
 'stranger sees only the two explicitly shown hole-card sets');
SELECT fixture_assert((SELECT bool_and(p->'cards'='null'::jsonb) FROM jsonb_array_elements(
 fn_poker_diamond_jackpot_hand_detail(current_setting('test.jackpot_id')::uuid)->'players') p
 WHERE p->>'userId' IN ('11000000-0000-0000-0000-000000000003','11000000-0000-0000-0000-000000000004')),
 'mucked and folded hole cards remain private');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT fixture_assert(fn_poker_diamond_jackpot_hand_detail(current_setting('test.jackpot_id')::uuid) IS NULL,
 'missing authenticated identity returns no awarded hand detail');
SELECT fixture_assert((SELECT difference=0 FROM fn_ca_diamond_register_vs_supply()),
 'all qualified success and rollback paths retain whole Diamond supply');
