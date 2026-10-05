-- ===========================================================================
--  THE DIAMOND BAD BEAT JACKPOT, THROUGH THE REAL DOORS
-- ===========================================================================
-- Every call below goes through fn_ca_settle_hand_stacks_absolute - the door
-- the commit door itself calls - or through the jackpot doors the migration
-- installed. Nothing is written to the jackpot ledger by hand.
--
-- The felt: four seats on one Diamond cash table, 300 Diamonds each, 1200 in
-- custody. Seat 4 is a horse.

SELECT fixture_assert(public.fn_ca_arena_diamonds() = 1200,
  'the arena float is 1200 before any hand: 1200 in custody, nothing in the jackpot');
SELECT fixture_assert(public.fn_poker_diamond_jackpot_diamonds() = 0,
  'the jackpot holds nothing before its first hand (B20: no seed)');

-- ---------------------------------------------------------------------------
-- 1. THE JACKPOT IS SHUT, AND THE SETTLER REFUSES A DROP BY NAME
-- ---------------------------------------------------------------------------
-- This is the state the migration leaves production in, and it is the state
-- the six boundary layers already describe. Proved first, because it is what
-- "amounts held at zero" has to mean.
SELECT fixture_assert(public.fn_ca_diamond_economic('bbj_enabled') = 0,
  'B14 is recorded as yes and the switch ships at 0: the jackpot is not open');
SELECT fixture_refuses($q$SELECT public.fn_ca_settle_hand_stacks_absolute(
  '30000000-0000-0000-0000-000000000001', 1000001,
  jsonb_build_array(
    jsonb_build_object('user_id','10000000-0000-0000-0000-000000000001','seat_id',(SELECT id FROM table_seats WHERE user_id='10000000-0000-0000-0000-000000000001'),'seat_joined_at','2026-09-10T01:00:00Z','stack_before',300,'stack',0),
    jsonb_build_object('user_id','10000000-0000-0000-0000-000000000002','seat_id',(SELECT id FROM table_seats WHERE user_id='10000000-0000-0000-0000-000000000002'),'seat_joined_at','2026-09-10T01:00:00Z','stack_before',300,'stack',100),
    jsonb_build_object('user_id','10000000-0000-0000-0000-000000000003','seat_id',(SELECT id FROM table_seats WHERE user_id='10000000-0000-0000-0000-000000000003'),'seat_joined_at','2026-09-10T01:00:00Z','stack_before',300,'stack',700),
    jsonb_build_object('user_id','10000000-0000-0000-0000-000000000004','seat_id',(SELECT id FROM table_seats WHERE user_id='10000000-0000-0000-0000-000000000004'),'seat_joined_at','2026-09-10T01:00:00Z','stack_before',300,'stack',100)),
  0, 300, null, 0)$q$, 'diamond_bad_beat_jackpot_not_open');
SELECT fixture_assert(public.fn_ca_arena_diamonds() = 1200
  AND (SELECT count(*) = 0 FROM poker_diamond_hand_receipts),
  'a refused drop moved nothing and left no receipt');

-- RAKE AND INSURANCE ARE STILL REFUSED OUTRIGHT, with or without the switch.
-- The layer was made conditional for the jackpot and for nothing else.
SELECT fixture_refuses($q$SELECT public.fn_ca_settle_hand_stacks_absolute(
  '30000000-0000-0000-0000-000000000001', 1000001,
  (SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,'stack_before',300,'stack',300) ORDER BY user_id) FROM table_seats),
  1, 0, null, 0)$q$, 'diamond_plain_cash_hand_required');
SELECT fixture_refuses($q$SELECT public.fn_ca_settle_hand_stacks_absolute(
  '30000000-0000-0000-0000-000000000001', 1000001,
  (SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,'stack_before',300,'stack',300) ORDER BY user_id) FROM table_seats),
  0, 0, null, 1)$q$, 'diamond_plain_cash_hand_required');

-- ---------------------------------------------------------------------------
-- 2. THE SWITCH IS TURNED ON THE WAY THE DESIGN SAYS: BY APPENDING A ROW
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_diamond_economics(name, scope, value, units, approved_quote, approved_on, basis, recorded_by)
VALUES ('bbj_enabled', 'all', 1, 'switch',
  'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.', DATE '2026-10-05',
  'The fixture opens the jackpot to prove the drop, the hit, the shares and the replay. Production keeps the 0 row this migration wrote.',
  'poker-diamond-bad-beat-jackpot-acceptance.sql');
SELECT fixture_assert(public.fn_ca_diamond_economic('bbj_enabled') = 1,
  'the newest row for a name is the current value: appending turned the jackpot on');
SELECT fixture_assert((SELECT count(*) = 2 FROM ca_diamond_economics WHERE name = 'bbj_enabled'),
  'the earlier answer was not overwritten; a new answer is a new row');
SELECT fixture_refuses($q$UPDATE ca_diamond_economics SET value = 1 WHERE name = 'bbj_pool_seed_diamonds'$q$,
  'append');
SELECT fixture_refuses($q$DELETE FROM ca_diamond_economics WHERE name = 'bbj_enabled'$q$, 'append');

-- ---------------------------------------------------------------------------
-- 3. THE SETTLER RECOMPUTES THE DROP AND REFUSES A DISAGREEMENT
-- ---------------------------------------------------------------------------
SELECT fixture_assert(public.fn_poker_diamond_jackpot_drop_due('30000000-0000-0000-0000-000000000001') = 300,
  'B15: a 10000 Diamond big blind owes floor(10000 * 0.03) = 300 whole Diamonds');
SELECT fixture_refuses($q$SELECT public.fn_ca_settle_hand_stacks_absolute(
  '30000000-0000-0000-0000-000000000001', 1000001,
  jsonb_build_array(
    jsonb_build_object('user_id','10000000-0000-0000-0000-000000000001','seat_id',(SELECT id FROM table_seats WHERE user_id='10000000-0000-0000-0000-000000000001'),'seat_joined_at','2026-09-10T01:00:00Z','stack_before',300,'stack',1),
    jsonb_build_object('user_id','10000000-0000-0000-0000-000000000002','seat_id',(SELECT id FROM table_seats WHERE user_id='10000000-0000-0000-0000-000000000002'),'seat_joined_at','2026-09-10T01:00:00Z','stack_before',300,'stack',100),
    jsonb_build_object('user_id','10000000-0000-0000-0000-000000000003','seat_id',(SELECT id FROM table_seats WHERE user_id='10000000-0000-0000-0000-000000000003'),'seat_joined_at','2026-09-10T01:00:00Z','stack_before',300,'stack',700),
    jsonb_build_object('user_id','10000000-0000-0000-0000-000000000004','seat_id',(SELECT id FROM table_seats WHERE user_id='10000000-0000-0000-0000-000000000004'),'seat_joined_at','2026-09-10T01:00:00Z','stack_before',300,'stack',100)),
  0, 299, null, 0)$q$, 'diamond_bbj_amount_disagrees_with_the_schedule');
-- A drop the stacks do not account for is refused by the conservation rule,
-- not quietly absorbed.
SELECT fixture_refuses($q$SELECT public.fn_ca_settle_hand_stacks_absolute(
  '30000000-0000-0000-0000-000000000001', 1000001,
  (SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,'stack_before',300,'stack',300) ORDER BY user_id) FROM table_seats),
  0, 300, null, 0)$q$, 'diamond_hand_does_not_conserve');
SELECT fixture_refuses($q$SELECT public.fn_ca_settle_hand_stacks_absolute(
  '30000000-0000-0000-0000-000000000001', 1000001,
  (SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,'stack_before',300,'stack',300) ORDER BY user_id) FROM table_seats),
  0, 300.5, null, 0)$q$, 'diamond_bbj_must_be_whole_diamonds');
SELECT fixture_assert(public.fn_poker_diamond_jackpot_diamonds() = 0
  AND public.fn_ca_arena_diamonds() = 1200,
  'every refused drop so far has moved nothing');

-- ---------------------------------------------------------------------------
-- 4. THE DROP (B15, B18). ONE HAND, THREE BANKS, SEVEN LEDGER ROWS
-- ---------------------------------------------------------------------------
-- p1 loses 300, p2 loses 200, p4 loses 200, p3 wins 400. The stacks fall by
-- 300 more than they rise, and 300 is what the stake owes.
CREATE TABLE fixture_bbj_register_before AS SELECT count(*) AS n FROM ca_mint_ledger;
CREATE TABLE fixture_bbj_hand AS
 SELECT jsonb_agg(jsonb_build_object('user_id', s.user_id, 'seat_id', s.id,
          'seat_joined_at', s.joined_at, 'stack_before', 300,
          'stack', CASE s.user_id
                     WHEN '10000000-0000-0000-0000-000000000001'::uuid THEN 0
                     WHEN '10000000-0000-0000-0000-000000000002'::uuid THEN 100
                     WHEN '10000000-0000-0000-0000-000000000003'::uuid THEN 700
                     ELSE 100 END)
        ORDER BY s.user_id) AS stacks
   FROM table_seats s;
CREATE TABLE fixture_bbj_result AS
 SELECT public.fn_ca_settle_hand_stacks_absolute(
   '30000000-0000-0000-0000-000000000001', 1000001, stacks, 0, 300, null, 0) AS r
   FROM fixture_bbj_hand;

SELECT fixture_assert((SELECT (r->>'success')::boolean AND (r->>'bbj')::numeric = 300
                       AND (r->'bbj_drop'->>'amount')::bigint = 300 FROM fixture_bbj_result),
  'the hand settled and its receipt carries the 300 Diamond drop');
SELECT fixture_assert(public.fn_poker_diamond_jackpot_diamonds() = 300,
  'the jackpot holds exactly the 300 Diamonds the hand dropped');
SELECT fixture_assert((SELECT sum(balance) = 900 FROM poker_diamond_custody WHERE state = 'active'),
  'custody fell by the drop and by nothing else: 1200 less 300 is 900');
SELECT fixture_assert(public.fn_ca_arena_diamonds() = 1200,
  'THE ARENA FLOAT IS UNCHANGED: custody to pool is arena to arena, so the money identity never moved');
SELECT fixture_assert((SELECT count(*) FROM ca_mint_ledger) = (SELECT n FROM fixture_bbj_register_before),
  'a drop writes NO register row, because nothing crossed between a player and the house');

-- B18, the shares of this one drop: 50 / 25 / 25 of 300.
SELECT fixture_assert(public.fn_poker_diamond_jackpot_bank(
  (SELECT id FROM poker_diamond_jackpot_pools WHERE status = 'active'), 'main') = 150,
  'B18: main took 50 percent of the drop, 150 Diamonds');
SELECT fixture_assert(public.fn_poker_diamond_jackpot_bank(
  (SELECT id FROM poker_diamond_jackpot_pools WHERE status = 'active'), 'backup') = 75,
  'B18: backup took 25 percent, 75 Diamonds');
SELECT fixture_assert(public.fn_poker_diamond_jackpot_bank(
  (SELECT id FROM poker_diamond_jackpot_pools WHERE status = 'active'), 'promotional') = 75,
  'B18: promotional took the remainder, 75 Diamonds, and the three re-sum to the drop');

-- The attribution: by loss, floored, remainder to the largest loser. Losses
-- are 300 / 200 / 200 out of 700, so main's 150 divides 65 / 43 / 42.
SELECT fixture_assert((SELECT sum(amount) = 300 FROM poker_diamond_jackpot_ledger WHERE kind = 'drop'),
  'every drop row together is the drop, exactly');
SELECT fixture_assert((SELECT count(*) = 9 FROM poker_diamond_jackpot_ledger WHERE kind = 'drop'),
  'three losers in three banks is nine rows, and the winner paid nothing');
SELECT fixture_assert((SELECT amount = 65 FROM poker_diamond_jackpot_ledger
  WHERE kind = 'drop' AND bank = 'main' AND payer_user_id = '10000000-0000-0000-0000-000000000001'),
  'the largest loser carries 65 of main''s 150: floor(150*300/700) is 64, and the remainder goes to the largest loser first');
SELECT fixture_assert((SELECT amount = 43 FROM poker_diamond_jackpot_ledger
  WHERE kind = 'drop' AND bank = 'main' AND payer_user_id = '10000000-0000-0000-0000-000000000002'),
  'the second remainder Diamond breaks the 200/200 tie by the lower user_id');
SELECT fixture_assert((SELECT amount = 42 FROM poker_diamond_jackpot_ledger
  WHERE kind = 'drop' AND bank = 'main' AND payer_user_id = '10000000-0000-0000-0000-000000000004'),
  'A HORSE PAYS ITS SHARE OF THE DROP ON THE SAME TERMS A HUMAN DOES (CLAUDE.md 10.5)');
SELECT fixture_assert((SELECT count(*) = 0 FROM poker_diamond_jackpot_ledger
  WHERE payer_user_id = '10000000-0000-0000-0000-000000000003'),
  'the player whose stack rose paid nothing into the jackpot');

-- ---------------------------------------------------------------------------
-- 5. A REPLAY OF THE SAME HAND DROPS NOTHING TWICE
-- ---------------------------------------------------------------------------
CREATE TABLE fixture_bbj_replay AS
 SELECT public.fn_ca_settle_hand_stacks_absolute(
   '30000000-0000-0000-0000-000000000001', 1000001, stacks, 0, 300, null, 0) AS r
   FROM fixture_bbj_hand;
SELECT fixture_assert((SELECT (r->>'replay')::boolean FROM fixture_bbj_replay),
  'the second delivery of the hand is a replay');
SELECT fixture_assert(public.fn_poker_diamond_jackpot_diamonds() = 300
  AND (SELECT count(*) = 9 FROM poker_diamond_jackpot_ledger WHERE kind = 'drop'),
  'THE REPLAY DROPPED NOTHING: still 300 Diamonds and still nine rows');
SELECT fixture_assert((SELECT sum(balance) = 900 FROM poker_diamond_custody WHERE state = 'active'),
  'the replay moved no custody either');

-- ---------------------------------------------------------------------------
-- 6. THE HIT (B16, B17, B19)
-- ---------------------------------------------------------------------------
-- The table moves to a 20 Diamond big blind, which is what the pot on this
-- felt can actually support: the payout floor is 10 big blinds, so a 600
-- Diamond pot clears 200 honestly rather than being asserted past the gate.
UPDATE public.tables SET small_blind = 10, big_blind = 20
 WHERE id = '30000000-0000-0000-0000-000000000001';
SELECT fixture_assert(public.fn_ca_diamond_economic('bbj_payout_total_percent', 'bb:20') = 70,
  'B19: a 20 Diamond big blind is in the High tier and pays 70 percent of main');

-- The gates refuse before the pool is touched.
SELECT fixture_refuses($q$SELECT public.fn_poker_diamond_jackpot_pay(
  '30000000-0000-0000-0000-000000000001', 1000002, 600, 2,
  '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003',
  ARRAY['10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000004']::uuid[])$q$,
  'diamond_jackpot_too_few_dealt_in');
SELECT fixture_refuses($q$SELECT public.fn_poker_diamond_jackpot_pay(
  '30000000-0000-0000-0000-000000000001', 1000002, 200, 4,
  '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003',
  ARRAY['10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000004']::uuid[])$q$,
  'diamond_jackpot_pot_below_the_payout_floor');
-- B16: a game with no jackpot can never win one.
UPDATE public.tables SET game_variant = 'plo6' WHERE id = '30000000-0000-0000-0000-000000000001';
SELECT fixture_refuses($q$SELECT public.fn_poker_diamond_jackpot_pay(
  '30000000-0000-0000-0000-000000000001', 1000002, 600, 4,
  '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003',
  ARRAY['10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000004']::uuid[])$q$,
  'diamond_jackpot_game_has_no_jackpot');
UPDATE public.tables SET game_variant = 'short_deck' WHERE id = '30000000-0000-0000-0000-000000000001';
SELECT fixture_refuses($q$SELECT public.fn_poker_diamond_jackpot_pay(
  '30000000-0000-0000-0000-000000000001', 1000002, 600, 4,
  '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003',
  ARRAY['10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000004']::uuid[])$q$,
  'diamond_jackpot_game_has_no_jackpot');
UPDATE public.tables SET game_variant = 'nlh' WHERE id = '30000000-0000-0000-0000-000000000001';
-- B15's symmetry: a stake that drops nothing can never hit.
UPDATE public.tables SET small_blind = 1, big_blind = 2 WHERE id = '30000000-0000-0000-0000-000000000001';
SELECT fixture_assert(public.fn_poker_diamond_jackpot_drop_due('30000000-0000-0000-0000-000000000001') = 0,
  'B15: a 2 Diamond big blind owes floor(2 * 0.25) = 0, so it drops nothing');
SELECT fixture_refuses($q$SELECT public.fn_poker_diamond_jackpot_pay(
  '30000000-0000-0000-0000-000000000001', 1000002, 600, 4,
  '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003',
  ARRAY['10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000004']::uuid[])$q$,
  'diamond_jackpot_stake_drops_nothing');
-- An unset stake refuses by its own name rather than borrowing another's price.
UPDATE public.tables SET small_blind = 1.5, big_blind = 3 WHERE id = '30000000-0000-0000-0000-000000000001';
SELECT fixture_refuses($q$SELECT public.fn_poker_diamond_jackpot_drop_due(
  '30000000-0000-0000-0000-000000000001')$q$, 'diamond_economics_unset:bbj_drop_diamonds/bb:3');
UPDATE public.tables SET small_blind = 10, big_blind = 20 WHERE id = '30000000-0000-0000-0000-000000000001';

SELECT fixture_assert(public.fn_poker_diamond_jackpot_diamonds() = 300,
  'none of those refusals took a Diamond out of the pool');

-- THE HIT. main holds 150, the High tier pays 70 percent of it, and the paid
-- total divides half / a quarter / a quarter in whole Diamonds:
--   paid        floor(150 * 70/100)  = 105
--   loser       floor(105 * 50/100)  =  52
--   winner      floor(105 * 25/100)  =  26
--   the table   105 - 52 - 26        =  27, which is 13 each to two players
--   left behind 105 - 52 - 26 - 26   =   1, and it stays in the main pool
CREATE TABLE fixture_bbj_hit AS
 SELECT public.fn_poker_diamond_jackpot_pay(
   '30000000-0000-0000-0000-000000000001', 1000002, 600, 4,
   '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003',
   ARRAY['10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000004']::uuid[]) AS r;

SELECT fixture_assert((SELECT (r->>'main_before')::bigint = 150 AND (r->>'payout_percent')::numeric = 70
                       AND (r->>'paid_total')::bigint = 105 FROM fixture_bbj_hit),
  'B19: the hit paid 70 percent of a 150 Diamond main pool, 105 Diamonds');
SELECT fixture_assert((SELECT (r->>'loser')::bigint = 52 AND (r->>'winner')::bigint = 26
                       AND (r->>'table_total')::bigint = 27 AND (r->>'table_each')::bigint = 13
                       FROM fixture_bbj_hit),
  'B19: half to the losing hand, a quarter to the winner, a quarter among the rest of the table');
SELECT fixture_assert((SELECT (r->>'paid_out')::bigint = 104 AND (r->>'left_in_main_pool')::bigint = 1
                       FROM fixture_bbj_hit),
  'the one Diamond no floor could allocate STAYED IN THE MAIN POOL; nothing was taken from a player to round it');
SELECT fixture_assert((SELECT (r->>'qualifying_hand') = 'AAAJJ' FROM fixture_bbj_hit),
  'B16: hold''em qualifies on aces full of jacks or better');

SELECT fixture_assert((SELECT diamonds = 752 FROM profiles WHERE id = '10000000-0000-0000-0000-000000000001'),
  'the losing hand was paid 52 into its wallet');
SELECT fixture_assert((SELECT diamonds = 99726 FROM profiles WHERE id = '10000000-0000-0000-0000-000000000003'),
  'the winning hand was paid 26');
SELECT fixture_assert((SELECT diamonds = 713 FROM profiles WHERE id = '10000000-0000-0000-0000-000000000002'),
  'the rest of the table was paid 13 each');
SELECT fixture_assert((SELECT diamonds = 99713 AND is_horse FROM profiles WHERE id = '10000000-0000-0000-0000-000000000004'),
  'A HORSE WAS PAID ITS 13 DIAMOND TABLE SHARE, on the same terms as the human beside it (CLAUDE.md 10.5)');

SELECT fixture_assert(public.fn_poker_diamond_jackpot_bank(
  (SELECT id FROM poker_diamond_jackpot_pools WHERE status = 'active'), 'main') = 46,
  'main fell by the 104 it paid out and by nothing else: 150 less 104 is 46');
SELECT fixture_assert(public.fn_poker_diamond_jackpot_diamonds() = 196,
  'the jackpot holds 196: 300 dropped less 104 paid');
SELECT fixture_assert(public.fn_ca_arena_diamonds() = 1096,
  'the arena float fell by exactly what the wallets gained: 1200 less 104');
SELECT fixture_assert((SELECT count(*) FROM ca_mint_ledger) = (SELECT n FROM fixture_bbj_register_before),
  'a payout writes NO register row either: pool to wallet is a transfer inside the player supply, exactly like a Diamond prize');
SELECT fixture_assert((SELECT count(*) = 4 FROM diamond_transactions
  WHERE type = 'arena_withdraw' AND description = 'Diamond Arena Bad Beat Jackpot'),
  'every payout carries its own wallet journal row: a balance never moves without one');

-- ---------------------------------------------------------------------------
-- 7. A REPLAY OF THE HIT PAYS NOTHING TWICE
-- ---------------------------------------------------------------------------
CREATE TABLE fixture_bbj_hit_replay AS
 SELECT public.fn_poker_diamond_jackpot_pay(
   '30000000-0000-0000-0000-000000000001', 1000002, 600, 4,
   '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003',
   ARRAY['10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000004']::uuid[]) AS r;
SELECT fixture_assert((SELECT (r->>'replay')::boolean AND (r->>'paid')::bigint = 104
                       FROM fixture_bbj_hit_replay),
  'the second delivery of the hit is a replay, and it reports what the first one paid');
SELECT fixture_assert(public.fn_poker_diamond_jackpot_diamonds() = 196
  AND (SELECT diamonds = 752 FROM profiles WHERE id = '10000000-0000-0000-0000-000000000001')
  AND (SELECT count(*) = 4 FROM poker_diamond_jackpot_ledger WHERE kind = 'payout'),
  'THE REPLAY PAID NOTHING: the pool, the wallets and the ledger are where the first hit left them');

-- ---------------------------------------------------------------------------
-- 8. THE RESEED, AND THE WITHDRAWAL (B21, B22)
-- ---------------------------------------------------------------------------
SELECT fixture_assert((public.fn_poker_diamond_jackpot_reseed(
  (SELECT id FROM poker_diamond_jackpot_pools WHERE status = 'active'))->>'reseeded')::boolean IS FALSE,
  'main is not empty, so there is nothing to reseed and the door says so rather than moving Diamonds');

-- B22: a withdrawn pool goes to the surviving pool, never to the house.
INSERT INTO public.clubs VALUES('20000000-0000-0000-0000-000000000002','diamonds',true,null);
INSERT INTO public.poker_diamond_jackpot_pools(arena_id) VALUES('20000000-0000-0000-0000-000000000002');
SELECT fixture_refuses($q$SELECT public.fn_poker_diamond_jackpot_withdraw(
  (SELECT id FROM poker_diamond_jackpot_pools WHERE arena_id='20000000-0000-0000-0000-000000000001'), NULL)$q$,
  'diamond_jackpot_withdrawal_needs_a_surviving_pool:contributing_players_pro_rata');
CREATE TABLE fixture_bbj_withdraw AS
 SELECT public.fn_poker_diamond_jackpot_withdraw(
   (SELECT id FROM poker_diamond_jackpot_pools WHERE arena_id='20000000-0000-0000-0000-000000000001' AND status='active'),
   (SELECT id FROM poker_diamond_jackpot_pools WHERE arena_id='20000000-0000-0000-0000-000000000002')) AS r;
SELECT fixture_assert((SELECT (r->>'total')::bigint = 196 FROM fixture_bbj_withdraw),
  'B22: all 196 Diamonds moved to the surviving pool');
SELECT fixture_assert(public.fn_poker_diamond_jackpot_diamonds() = 196,
  'the withdrawal moved Diamonds between pools and created or destroyed none');
SELECT fixture_assert((SELECT status = 'retired_settled' AND merged_into_pool_id IS NOT NULL
  FROM poker_diamond_jackpot_pools WHERE arena_id='20000000-0000-0000-0000-000000000001'),
  'the retired pool reads retired_settled and names the pool its money went to, exactly as the one retired chip pool does');
SELECT fixture_assert((SELECT sum(amount) = 0 FROM poker_diamond_jackpot_ledger
  WHERE pool_id = (SELECT id FROM poker_diamond_jackpot_pools WHERE arena_id='20000000-0000-0000-0000-000000000001')),
  'the withdrawn pool holds nothing, and its history is still every row it ever had');
SELECT fixture_assert((SELECT count(*) = 0 FROM ca_diamond_house WHERE balance <> 0),
  'NOT ONE DIAMOND OF THE POOL REACHED THE HOUSE');

-- ---------------------------------------------------------------------------
-- 9. THE CHIP JACKPOT POOL REFUSES THE DIAMOND ARENA BY NAME
-- ---------------------------------------------------------------------------
SELECT fixture_refuses($q$INSERT INTO public.bbj_pools(club_id) VALUES('20000000-0000-0000-0000-000000000001')$q$,
  'The Diamond Arena Has No Chip Jackpot Pool Or Chip Contribution');
SELECT fixture_refuses($q$INSERT INTO public.bbj_contributions(club_id, amount) VALUES('20000000-0000-0000-0000-000000000001', 5)$q$,
  'The Diamond Arena Has No Chip Jackpot Pool Or Chip Contribution');
SELECT fixture_assert((SELECT count(*) = 0 FROM bbj_pools) AND (SELECT count(*) = 0 FROM bbj_contributions),
  'no Diamond row reached a chip jackpot pool or a chip contribution');

SELECT fixture_assert(true,
  'DIAMOND BAD BEAT JACKPOT: drop, shares, hit, replay, reseed, withdrawal and the chip fence all certified on isolated PostgreSQL 17');
