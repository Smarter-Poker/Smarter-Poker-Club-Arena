\set ON_ERROR_STOP on
-- A DIAMOND TABLE MAY BOMB, AND STILL HAS TO ANTE A WHOLE DIAMOND.
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);

UPDATE public.tables SET bomb_pot_enabled=true, bomb_pot_ante_multiplier=2,
 bomb_pot_board_count=1, bomb_pot_double_board=false, bomb_pot_variant=NULL
 WHERE id='30000000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT set_config('request.jwt.claims','{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000001"}',false);
SELECT atomic_table_buyin('10000000-0000-0000-0000-000000000001',
 '30000000-0000-0000-0000-000000000001',1,100,false,'20000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000041');
SELECT fixture_assert((SELECT count(*)=1 FROM public.table_seats WHERE left_at IS NULL)
 AND (SELECT count(*)=1 FROM public.poker_diamond_custody WHERE state='active' AND balance=100),
 'a bombing Diamond table admits a seat and funds it from custody');

-- Three boards is a board count, not a money fact.
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);
UPDATE public.tables SET bomb_pot_board_count=3, bomb_pot_double_board=true
 WHERE id='30000000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',false);
SELECT atomic_table_buyin('10000000-0000-0000-0000-000000000002',
 '30000000-0000-0000-0000-000000000001',2,100,false,'20000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000042');
SELECT fixture_assert((SELECT count(*)=2 FROM public.table_seats WHERE left_at IS NULL),
 'a three-board bomb pot is admitted on the same terms');

-- WHAT THE BOMB COLUMNS STILL REFUSE.
DO $cases$
DECLARE v_case record;
BEGIN
 FOR v_case IN SELECT * FROM (VALUES
   ('bomb_pot_ante_fixed=2.5','bomb_pot_ante_fixed=0','diamond_bomb_pot_requires_a_whole_ante',
    'a fixed ante that is not a whole Diamond'),
   ('bomb_pot_ante_multiplier=0','bomb_pot_ante_multiplier=2','diamond_bomb_pot_requires_a_whole_ante',
    'an ante of nothing'),
   ('bomb_pot_variant=''plo4''','bomb_pot_variant=NULL','diamond_bomb_pot_requires_the_table_game',
    'bombs in a game the table is not certified for'),
   ('bomb_pot_variant=''PLO5''','bomb_pot_variant=NULL','diamond_bomb_pot_requires_the_table_game',
    'the same override in capitals')
 ) AS t(mutation,reset,err,why) LOOP
  PERFORM set_config('request.jwt.claim.role','service_role',false);
  PERFORM set_config('request.jwt.claim.sub','',false);
  EXECUTE format('UPDATE public.tables SET %s WHERE id=%L',v_case.mutation,
    '30000000-0000-0000-0000-000000000001');
  PERFORM set_config('request.jwt.claim.role','authenticated',false);
  PERFORM set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
  PERFORM public.fixture_refuses($q$SELECT atomic_table_buyin(
    '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',3,100,false,
    '20000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000043')$q$,
    v_case.err);
  RAISE NOTICE 'PASS: % is refused at the door', v_case.why;
  PERFORM set_config('request.jwt.claim.role','service_role',false);
  PERFORM set_config('request.jwt.claim.sub','',false);
  EXECUTE format('UPDATE public.tables SET %s WHERE id=%L',v_case.reset,
    '30000000-0000-0000-0000-000000000001');
 END LOOP;
END $cases$;

-- The bomb columns bind only while the feature is on.
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);
UPDATE public.tables SET bomb_pot_enabled=false, bomb_pot_ante_fixed=2.5,
 bomb_pot_variant='plo4' WHERE id='30000000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',false);
SELECT atomic_table_buyin('10000000-0000-0000-0000-000000000003',
 '30000000-0000-0000-0000-000000000001',3,100,false,'20000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000044');
SELECT fixture_assert((SELECT count(*)=3 FROM public.table_seats WHERE left_at IS NULL),
 'a stale bomb column on a table that is not bombing refuses nobody');

-- And everything the door refused before bomb pots left it is still refused.
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);
UPDATE public.tables SET insurance_enabled=true
 WHERE id='30000000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT fixture_refuses($q$SELECT atomic_table_buyin(
 '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',4,100,false,
 '20000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000045')$q$,
 'diamond_plain_cash_table_required');

-- The staff door asks for a caller first and for staff second.
SELECT set_config('request.jwt.claim.sub','',false);
SELECT fixture_refuses($q$SELECT fn_poker_diamond_set_table_bomb_pot(
 '30000000-0000-0000-0000-000000000001',true,2,1::smallint)$q$,'authentication required');
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT fixture_refuses($q$SELECT fn_poker_diamond_set_table_bomb_pot(
 '30000000-0000-0000-0000-000000000001',true,2,1::smallint)$q$,'diamond_table_staff_only');
