\set ON_ERROR_STOP on
-- A FORGED ARENA ON A DIAMOND PURCHASE MOVES NOTHING (2026-09-19).
-- The buy-in door takes a client-supplied p_club_id because the chip estate
-- uses it to choose which union wallet pays. On a Diamond table the arena is
-- the TABLE's arena and nothing the client says can change it: a chip club
-- supplied against a Diamond table is refused before any wallet, custody,
-- seat, membership or receipt row is written. Runs after
-- poker-diamond-cash-admission-acceptance.sql, when both fixture players have
-- cashed out and every Diamond is back in its wallet.
INSERT INTO clubs(id,asset,is_platform,union_id)
 VALUES('20000000-0000-0000-0000-00000000c1a5','chips',false,NULL);
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT set_config('request.jwt.claims',
 '{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000001"}',false);
SELECT fixture_assert((SELECT sum(diamonds)=2000 FROM profiles)
 AND (SELECT count(*)=0 FROM table_seats WHERE left_at IS NULL),
 'forgery starts from a settled fixture with every Diamond in a wallet');
SELECT fixture_refuses($q$SELECT atomic_table_buyin(
 '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',1,100,false,
 '20000000-0000-0000-0000-00000000c1a5','40000000-0000-0000-0000-00000000f0f0')$q$,
 'diamond_purchase_arena_mismatch');
SELECT fixture_assert((SELECT sum(diamonds)=2000 FROM profiles)
 AND (SELECT count(*)=0 FROM table_seats WHERE left_at IS NULL)
 AND (SELECT count(*)=0 FROM poker_diamond_custody WHERE state IN ('active','reserved'))
 AND (SELECT count(*)=0 FROM club_members)
 AND (SELECT count(*)=0 FROM entry_purchase_idempotency_receipts
       WHERE idempotency_key='40000000-0000-0000-0000-00000000f0f0'),
 'forged chip club on a Diamond purchase writes no wallet custody seat membership or receipt');
-- The same forged club as a SECOND player: the refusal is not about who asks.
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',false);
SELECT fixture_refuses($q$SELECT atomic_table_buyin(
 '10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001',2,100,false,
 '20000000-0000-0000-0000-00000000c1a5','40000000-0000-0000-0000-00000000f0f1')$q$,
 'diamond_purchase_arena_mismatch');
-- And the honest shape still works from the same session: the table decides.
SELECT atomic_table_buyin('10000000-0000-0000-0000-000000000002',
 '30000000-0000-0000-0000-000000000001',2,100,false,
 '20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-00000000f0f2');
SELECT fixture_assert((SELECT count(*)=1 FROM table_seats WHERE left_at IS NULL
   AND user_id='10000000-0000-0000-0000-000000000002' AND club_id='20000000-0000-0000-0000-000000000001')
 AND (SELECT sum(diamonds)=1900 FROM profiles)
 AND (SELECT sum(balance)=100 FROM poker_diamond_custody WHERE state='active')
 AND (SELECT count(*)=0 FROM club_members),
 'the honest purchase seats through Diamond custody with no chip membership');
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);
SELECT fn_cashout_seat_occupancy('10000000-0000-0000-0000-000000000002',
 '30000000-0000-0000-0000-000000000001',2,
 (SELECT occupancy_id FROM table_seats WHERE left_at IS NULL AND seat_number=2),'voluntary');
SELECT fixture_assert((SELECT sum(diamonds)=2000 FROM profiles)
 AND (SELECT sum(balance)=0 FROM poker_diamond_custody)
 AND (SELECT count(*)=0 FROM table_seats WHERE left_at IS NULL),
 'forgery case leaves the fixture settled again');
DELETE FROM clubs WHERE id='20000000-0000-0000-0000-00000000c1a5';
