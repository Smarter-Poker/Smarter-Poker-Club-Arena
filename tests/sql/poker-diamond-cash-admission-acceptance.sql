
SELECT fixture_assert((SELECT count(*)=2 FROM table_seats WHERE left_at IS NULL)
 AND (SELECT count(*)=2 FROM poker_diamond_custody WHERE state='active')
 AND (SELECT count(*)=2 FROM entry_purchase_idempotency_receipts),
 'public purchase creates one seat, custody and receipt per user');
SELECT fixture_assert((SELECT bool_and(c.seat_id=s.id AND c.seat_joined_at=s.joined_at
 AND c.occupancy_id=s.occupancy_id AND c.balance=s.stack AND c.arena_id=s.club_id)
 FROM poker_diamond_custody c JOIN table_seats s ON s.id=c.seat_id WHERE c.state='active'),
 'custody binds the final shared-trigger occupancy');
SELECT fixture_assert((SELECT sum(diamonds)=1800 FROM profiles)
 AND (SELECT sum(balance)=200 FROM poker_diamond_custody),
 'authenticated purchase moves Diamonds from available to custody');
SELECT fixture_assert((SELECT count(*)=0 FROM club_members),
 'authenticated purchase creates no chip membership');

SELECT fixture_refuses($q$
 UPDATE table_seats SET stack=stack+1 WHERE left_at IS NULL AND seat_number=1;
 SET CONSTRAINTS ALL IMMEDIATE
$q$,'diamond_seat_and_custody_must_commit_together');
SELECT fixture_refuses($q$
 DELETE FROM table_seats WHERE left_at IS NULL AND seat_number=1;
 SET CONSTRAINTS ALL IMMEDIATE
$q$,'diamond_seat_and_custody_must_commit_together');
SELECT fixture_assert((SELECT sum(stack)=200 FROM table_seats WHERE left_at IS NULL),
 'direct stack or seat deletion rolls back');
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',false);
SELECT set_config('request.jwt.claims','{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000001"}',false);
SELECT fixture_assert(fn_ca_cash_buyin_receipt('40000000-0000-0000-0000-000000000006',
 '30000000-0000-0000-0000-000000000001')->>'status'='unconfirmed',
 'another player cannot read a purchase receipt');
SELECT fixture_refuses($q$SELECT fn_cashout_seat_occupancy(
 '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',1,
 (SELECT occupancy_id FROM table_seats WHERE left_at IS NULL AND seat_number=1),'voluntary')$q$,
 'Engine authority required');
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);
SELECT fixture_refuses($q$SELECT fn_cashout_seat_occupancy(
 '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',1,
 gen_random_uuid(),'voluntary')$q$,'CASHOUT_STALE_OCCUPANCY');
SELECT fn_ca_settle_hand_stacks_absolute('30000000-0000-0000-0000-000000000001',1000003,
 (SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,
 'seat_joined_at',joined_at,'stack_before',100,'stack',CASE WHEN seat_number=1 THEN 50 ELSE 150 END))
 FROM table_seats WHERE left_at IS NULL),0,0,NULL,0);
CREATE TABLE fixture_occupancy_exits AS SELECT user_id,table_id,seat_number,occupancy_id,
 fn_cashout_seat_occupancy(user_id,table_id,seat_number,occupancy_id,'voluntary') receipt
 FROM table_seats WHERE left_at IS NULL;
SELECT fixture_assert((SELECT sum(diamonds)=2000 FROM profiles)
 AND (SELECT sum(balance)=0 FROM poker_diamond_custody)
 AND (SELECT count(*)=0 FROM table_seats WHERE left_at IS NULL),
 'purchase, settled partial pot and occupancy cash-out reconcile every Diamond');
SELECT fixture_assert((SELECT bool_and(fn_cashout_seat_occupancy(
 user_id,table_id,seat_number,occupancy_id,'voluntary')=receipt) FROM fixture_occupancy_exits),
 'occupancy cash-out response-loss retry returns the exact original receipt');
SELECT fixture_assert((SELECT count(*)=2 FROM seat_cashout_receipts),
 'each final occupancy has one cash-out receipt');
SELECT fixture_assert((SELECT consumed=350 AND arena_reserved=0 FROM diamond_purchase_lots),
 'partial hand loss consumes only lost purchased units and releases the remainder');
SELECT fixture_assert((SELECT count(*)=0 FROM club_members),
 'complete custody path creates no chip membership');

SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT set_config('request.jwt.claims','{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000001"}',false);
SELECT fixture_assert((SELECT fn_poker_diamond_cashout_receipt(table_id,occupancy_id)
 =jsonb_build_object('asset','diamonds','table_id',table_id,'occupancy_id',occupancy_id,'amount',50)
 FROM fixture_occupancy_exits WHERE seat_number=1),'owner recovers the exact Diamond cashout result');
SELECT fixture_assert((SELECT fn_poker_diamond_cashout_receipt(table_id,occupancy_id) IS NULL
 FROM fixture_occupancy_exits WHERE seat_number=2),'other players cannot read a Diamond cashout receipt');
SELECT fixture_refuses($q$SELECT fn_poker_diamond_cashout_receipt(gen_random_uuid(),occupancy_id)
 FROM fixture_occupancy_exits WHERE seat_number=1$q$,'CASHOUT_OCCUPANCY_SCOPE_MISMATCH');
SELECT set_config('request.jwt.claims','{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000009"}',false);
SELECT fixture_refuses($q$SELECT fn_poker_diamond_cashout_receipt(table_id,occupancy_id)
 FROM fixture_occupancy_exits WHERE seat_number=1$q$,'Authentication Required');
SELECT fixture_assert(NOT has_function_privilege('anon','fn_poker_diamond_cashout_receipt(uuid,uuid)','EXECUTE')
 AND has_function_privilege('authenticated','fn_poker_diamond_cashout_receipt(uuid,uuid)','EXECUTE'),
 'receipt read is authenticated only');
