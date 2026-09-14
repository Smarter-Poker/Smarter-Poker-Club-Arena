SELECT fixture_assert((SELECT sum(stack)=600 FROM table_seats)
 AND (SELECT sum(balance)=600 FROM poker_diamond_custody),
 'settled seats and custody conserve every Diamond');
SELECT fixture_assert((SELECT consumed=300 AND arena_reserved=0 FROM diamond_purchase_lots),
 'actual purchased loss consumes held liability once');
SELECT fixture_assert((SELECT count(*)=1 FROM poker_diamond_hand_receipts),
 'concurrent replay retains one hand receipt');
SELECT fixture_assert((SELECT sum(diamonds)=1400 FROM profiles)
 AND (SELECT count(*)=4 FROM diamond_transactions),
 'hand settlement does not write available wallets or mint a journal');
SELECT fixture_refuses($q$SELECT fn_ca_settle_hand_stacks_absolute(
 '30000000-0000-0000-0000-000000000001',1000001,
 jsonb_set(jsonb_set(stacks,'{0,stack}','100'),'{1,stack}','500'),0,0,null,0)
 FROM fixture_diamond_hand_input$q$,'diamond_hand_payload_mismatch');
SELECT fixture_refuses($q$SELECT fn_ca_settle_hand_stacks_absolute(
 '30000000-0000-0000-0000-000000000001',1000002,stacks,0,0,null,0)
 FROM fixture_diamond_hand_input$q$,'diamond_hand_stale_seat');

-- A missing or mismatched occupancy cannot release active custody.
UPDATE table_seats SET left_at=now();
BEGIN;
UPDATE table_seats SET occupancy_id=gen_random_uuid() WHERE seat_number=1;
SELECT fixture_refuses($q$SELECT fn_poker_diamond_release(
 (SELECT id FROM poker_diamond_custody WHERE state='active' ORDER BY user_id LIMIT 1),
 '50000000-0000-0000-0000-000000000002')$q$,'diamond_custody_requires_settlement');
ROLLBACK;
CREATE TABLE fixture_cash_exits AS SELECT c.user_id,
 fn_poker_diamond_release(c.id,md5('phase6-exit:'||c.id)::uuid) receipt
 FROM poker_diamond_custody c WHERE c.state='active';
SELECT fixture_assert((SELECT sum(diamonds)=2000 FROM profiles)
 AND (SELECT sum(balance)=0 FROM poker_diamond_custody),
 'full cash-out restores total supply to available wallets');
SELECT fixture_assert((SELECT receipt->>'amount'='0' AND receipt->'journal_id'='null'::jsonb
 FROM fixture_cash_exits WHERE user_id='10000000-0000-0000-0000-000000000001'),
 'busted zero exit has a retained receipt and no fabricated wallet journal');
SELECT fixture_assert((SELECT count(*)=5 FROM diamond_transactions),
 'only the positive cash-out writes a wallet journal');
SELECT fixture_assert((SELECT bool_and(fn_poker_diamond_release(
 (receipt->>'custody_id')::uuid,(receipt->>'request_id')::uuid)=receipt)
 FROM fixture_cash_exits),'response-loss cash-out retry returns the original receipt');
SELECT fixture_assert((SELECT bool_and(state='released' AND balance=0) FROM poker_diamond_custody),
 'all custody is released once');
SELECT fixture_assert((SELECT sum(amount)=0 FROM diamond_transactions),
 'reserve and final cash-out journals conserve across players');
SELECT fixture_assert((SELECT count(*)=0 FROM club_members),
 'custody path creates no chip membership or hierarchy');
SELECT fixture_refuses($q$UPDATE poker_diamond_hand_receipts SET receipt='{}'$q$,'append-only');
SELECT fixture_refuses($q$INSERT INTO poker_diamond_movements(
 request_id,custody_id,user_id,action,amount,source_account,destination_account,request,receipt)
 SELECT gen_random_uuid(),id,user_id,'reserve',0,'a','b','{}','{}'
 FROM poker_diamond_custody LIMIT 1$q$,'poker_diamond_movements_amount_check');
