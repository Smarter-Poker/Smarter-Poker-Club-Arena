\set ON_ERROR_STOP on
-- A DIAMOND SEAT TOPS UP FROM THE CUSTODY IT SAT WITH.
--
-- Request ids here start at 70000000-. The 50000000- range is already used by
-- the custody contract fixture, and reusing one of those made the FIRST call
-- below answer idempotency_payload_mismatch instead of the refusal it was
-- written to prove: correct behaviour from the door, a worthless test.
--
-- Two players are seated with 100 each. Everything below is measured against
-- that, in the isolated fixture, through the real door.
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);

CREATE TABLE fixture_top_up_before AS
 SELECT (SELECT sum(diamonds) FROM profiles WHERE id IN ('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002')) wallet,
        (SELECT sum(stack) FROM table_seats WHERE left_at IS NULL) stack,
        (SELECT sum(balance) FROM poker_diamond_custody WHERE state='active') custody,
        (SELECT count(*) FROM poker_diamond_lot_reservations) lot_rows,
        (SELECT sum(arena_reserved) FROM diamond_purchase_lots) reserved;

SELECT fixture_assert((SELECT stack=200 AND custody=200 FROM fixture_top_up_before)
 AND (SELECT diamonds=600 FROM profiles WHERE id='10000000-0000-0000-0000-000000000001')
 AND (SELECT diamonds=1200 FROM profiles WHERE id='10000000-0000-0000-0000-000000000002'),
 'two seated players hold 100 each in custody before any top-up');

-- REFUSALS. Every one of these must leave the fixture exactly as it was.
SELECT fixture_refuses($q$SELECT fn_poker_diamond_top_up(
 '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 10.5,100,'70000000-0000-0000-0000-000000000001')$q$,'invalid_diamond_top_up');
SELECT fixture_refuses($q$SELECT fn_poker_diamond_top_up(
 '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 0,100,'70000000-0000-0000-0000-000000000001')$q$,'invalid_diamond_top_up');
SELECT fixture_refuses($q$SELECT fn_poker_diamond_top_up(
 '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 10,99,'70000000-0000-0000-0000-000000000001')$q$,'diamond_top_up_stale_seat');
SELECT fixture_refuses($q$SELECT fn_poker_diamond_top_up(
 '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 901,100,'70000000-0000-0000-0000-000000000001')$q$,'diamond_top_up_exceeds_max_buy_in');
SELECT fixture_refuses($q$SELECT fn_poker_diamond_top_up(
 '10000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001',
 10,0,'70000000-0000-0000-0000-000000000001')$q$,'diamond_top_up_requires_a_live_seat');
SELECT fixture_assert(
 (SELECT (SELECT sum(diamonds) FROM profiles WHERE id IN ('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002'))=b.wallet
   AND (SELECT sum(stack) FROM table_seats WHERE left_at IS NULL)=b.stack
   AND (SELECT sum(balance) FROM poker_diamond_custody WHERE state='active')=b.custody
   AND (SELECT sum(arena_reserved) FROM diamond_purchase_lots)=b.reserved
  FROM fixture_top_up_before b),
 'a refused top-up moves no wallet, no stack, no custody and no purchase lot');

-- THE DOOR IS ENGINE-ONLY.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT fixture_refuses($q$SELECT fn_poker_diamond_top_up(
 '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 50,100,'70000000-0000-0000-0000-000000000002')$q$,'permission denied');
RESET ROLE;
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);

-- THE TOP-UP ITSELF.
SELECT fn_poker_diamond_top_up('10000000-0000-0000-0000-000000000001',
 '30000000-0000-0000-0000-000000000001',50,100,'70000000-0000-0000-0000-000000000003');
SELECT fixture_assert(
 (SELECT stack=150 FROM table_seats WHERE left_at IS NULL AND seat_number=1)
 AND (SELECT balance=150 FROM poker_diamond_custody c JOIN table_seats s ON s.id=c.seat_id
      WHERE c.state='active' AND s.seat_number=1)
 AND (SELECT diamonds=550 FROM profiles WHERE id='10000000-0000-0000-0000-000000000001'),
 'the seat, its custody and the wallet move together by the same 50');
SELECT fixture_assert((SELECT count(*)=1 FROM poker_diamond_movements
 WHERE request_id='70000000-0000-0000-0000-000000000003' AND action='reserve' AND amount=50
   AND source_account='player:10000000-0000-0000-0000-000000000001'),
 'the top-up posts one reserve movement from the player to the custody');
SELECT fixture_assert((SELECT count(*)=1 FROM diamond_transactions
 WHERE reference_id='poker-topup:70000000-0000-0000-0000-000000000003'
   AND type='arena_deposit' AND amount=-50 AND balance_after=550),
 'the wallet journal records the arena deposit before the balance moved');
SELECT fixture_assert((SELECT wallet_journal_id=(SELECT id FROM diamond_transactions
   WHERE reference_id='poker-topup:70000000-0000-0000-0000-000000000003')
  FROM poker_diamond_movements WHERE request_id='70000000-0000-0000-0000-000000000003'),
 'the movement names the journal row it was written with');

-- THE LOT HOLD IS RAISED, NOT DUPLICATED. (custody_id, lot_id) is the primary
-- key and the hand settler consumes a lot BY that key: a second row for the
-- same pair would let one loss be taken twice.
SELECT fixture_assert((SELECT count(*) FROM poker_diamond_lot_reservations)
 =(SELECT lot_rows FROM fixture_top_up_before),
 'a top-up on a lot this custody already holds raises that hold, it does not add a row');
-- Only the first player's Diamonds came from a settled purchase lot in this
-- fixture; the second player's wallet has none behind it, which fn_poker_diamond_reserve
-- already allows and this door inherits unchanged. So the numbers below are
-- that one player's, not the table's.
SELECT fixture_assert((SELECT count(*)=1 AND sum(amount)=150
  FROM poker_diamond_lot_reservations r JOIN poker_diamond_custody c ON c.id=r.custody_id
  WHERE c.state='active' AND c.user_id='10000000-0000-0000-0000-000000000001'
    AND r.released_at IS NULL),
 'the 100 bought in and the 50 topped up are ONE hold of 150 on one lot');
SELECT fixture_assert((SELECT sum(arena_reserved)=150 FROM diamond_purchase_lots)
 AND (SELECT sum(amount)=150 FROM poker_diamond_lot_reservations WHERE released_at IS NULL),
 'the reserved purchase lots and the open reservation rows agree');

-- IDEMPOTENCY.
SELECT fixture_assert((fn_poker_diamond_top_up('10000000-0000-0000-0000-000000000001',
 '30000000-0000-0000-0000-000000000001',50,100,'70000000-0000-0000-0000-000000000003')
 ->>'stack')::bigint=150,
 'replaying the same request id returns the first receipt');
SELECT fixture_assert((SELECT diamonds=550 FROM profiles WHERE id='10000000-0000-0000-0000-000000000001')
 AND (SELECT stack=150 FROM table_seats WHERE left_at IS NULL AND seat_number=1)
 AND (SELECT count(*)=1 FROM poker_diamond_movements WHERE request_id='70000000-0000-0000-0000-000000000003'),
 'the replay charged nothing a second time');
SELECT fixture_refuses($q$SELECT fn_poker_diamond_top_up(
 '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 60,100,'70000000-0000-0000-0000-000000000003')$q$,'idempotency_payload_mismatch');

-- THE SEAT AND ITS CUSTODY ARE STILL WELDED TOGETHER.
SELECT fixture_refuses($q$
 UPDATE table_seats SET stack=stack+1 WHERE left_at IS NULL AND seat_number=1;
 SET CONSTRAINTS ALL IMMEDIATE
$q$,'diamond_seat_and_custody_must_commit_together');

-- A HAND STILL SETTLES ON THE TOPPED-UP STACK, AND THE LOSS CONSUMES THE
-- RAISED HOLD RATHER THAN OVERDRAWING IT.
SELECT fn_ca_settle_hand_stacks_absolute('30000000-0000-0000-0000-000000000001',1000101,
 (SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,
  'seat_joined_at',joined_at,'stack_before',stack,
  'stack',CASE WHEN seat_number=1 THEN 50 ELSE 200 END))
  FROM table_seats WHERE left_at IS NULL),0,0,NULL,0);
SELECT fixture_assert((SELECT sum(stack)=250 FROM table_seats WHERE left_at IS NULL)
 AND (SELECT sum(balance)=250 FROM poker_diamond_custody WHERE state='active')
 AND (SELECT bool_and(c.balance=s.stack) FROM poker_diamond_custody c
      JOIN table_seats s ON s.id=c.seat_id WHERE c.state='active'),
 'the hand after a top-up conserves and leaves every seat equal to its custody');

-- AND EVERY DIAMOND COMES BACK.
CREATE TABLE fixture_top_up_exits AS SELECT user_id,table_id,seat_number,occupancy_id,
 fn_cashout_seat_occupancy(user_id,table_id,seat_number,occupancy_id,'voluntary') receipt
 FROM table_seats WHERE left_at IS NULL;
SELECT fixture_assert((SELECT sum(diamonds)=2000 FROM profiles WHERE id IN ('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002'))
 AND (SELECT count(*)=0 FROM table_seats WHERE left_at IS NULL)
 AND (SELECT COALESCE(sum(balance),0)=0 FROM poker_diamond_custody WHERE state='active')
 AND (SELECT COALESCE(sum(arena_reserved),0)=0 FROM diamond_purchase_lots),
 'the topped-up Diamonds return to the wallets and release every purchase hold');
SELECT fixture_assert((SELECT count(*)=0 FROM fixture_incidents),
 'no Diamond incident was raised anywhere on this path');
