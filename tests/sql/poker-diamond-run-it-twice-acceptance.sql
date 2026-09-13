\set ON_ERROR_STOP on
-- A DIAMOND TABLE MAY RUN IT TWICE, AND STILL HAS TO SAY SO.
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);

UPDATE public.tables SET run_it_twice=true, allow_run_it_twice=true, run_it_twice_enabled=false
 WHERE id='30000000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT set_config('request.jwt.claims','{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000001"}',false);
SELECT atomic_table_buyin('10000000-0000-0000-0000-000000000001',
 '30000000-0000-0000-0000-000000000001',1,100,false,'20000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000031');
SELECT fixture_assert((SELECT count(*)=1 FROM public.table_seats WHERE left_at IS NULL)
 AND (SELECT count(*)=1 FROM public.poker_diamond_custody WHERE state='active' AND balance=100),
 'a table that runs it twice admits a seat and funds it from custody');

-- The third column is the other way the engine can be told yes.
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);
UPDATE public.tables SET run_it_twice=false, allow_run_it_twice=false, run_it_twice_enabled=true
 WHERE id='30000000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',false);
SELECT atomic_table_buyin('10000000-0000-0000-0000-000000000002',
 '30000000-0000-0000-0000-000000000001',2,100,false,'20000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000032');
SELECT fixture_assert((SELECT count(*)=2 FROM public.table_seats WHERE left_at IS NULL),
 'run_it_twice_enabled on its own is admitted on the same terms');

-- BUT A COLUMN THAT NEVER SAID IS STILL REFUSED, because the engine reads an
-- absent one as TRUE and this arena inherits nothing from the chip schedule.
DO $cases$
DECLARE v_case record;
BEGIN
 FOR v_case IN SELECT * FROM (VALUES
   ('run_it_twice=NULL','run_it_twice=false','an unset run-it column'),
   ('allow_run_it_twice=NULL','allow_run_it_twice=false','an unset allow-run-it column')
 ) AS t(mutation,reset,why) LOOP
  PERFORM set_config('request.jwt.claim.role','service_role',false);
  PERFORM set_config('request.jwt.claim.sub','',false);
  EXECUTE format('UPDATE public.tables SET %s WHERE id=%L',v_case.mutation,
    '30000000-0000-0000-0000-000000000001');
  PERFORM set_config('request.jwt.claim.role','authenticated',false);
  PERFORM set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
  PERFORM public.fixture_refuses($q$SELECT atomic_table_buyin(
    '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',3,100,false,
    '20000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000033')$q$,
    'diamond_plain_cash_table_required');
  RAISE NOTICE 'PASS: % is still refused at the door', v_case.why;
  PERFORM set_config('request.jwt.claim.role','service_role',false);
  PERFORM set_config('request.jwt.claim.sub','',false);
  EXECUTE format('UPDATE public.tables SET %s WHERE id=%L',v_case.reset,
    '30000000-0000-0000-0000-000000000001');
 END LOOP;
END $cases$;

-- And everything the block refused before run it twice left it is still refused.
DO $cases$
DECLARE v_case record;
BEGIN
 FOR v_case IN SELECT * FROM (VALUES
   ('insurance_enabled=true','insurance_enabled=false','insurance'),
   ('bomb_pot_enabled=true','bomb_pot_enabled=false','a bomb pot'),
   ('seven_deuce_enabled=true','seven_deuce_enabled=false','the seven-deuce side bet'),
   ('rake_cap_bb=NULL','rake_cap_bb=0','an unset rake cap'),
   ('bbj_percent=NULL','bbj_percent=0','an unset jackpot percentage')
 ) AS t(mutation,reset,why) LOOP
  PERFORM set_config('request.jwt.claim.role','service_role',false);
  PERFORM set_config('request.jwt.claim.sub','',false);
  EXECUTE format('UPDATE public.tables SET %s WHERE id=%L',v_case.mutation,
    '30000000-0000-0000-0000-000000000001');
  PERFORM set_config('request.jwt.claim.role','authenticated',false);
  PERFORM set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
  PERFORM public.fixture_refuses($q$SELECT atomic_table_buyin(
    '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',3,100,false,
    '20000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000034')$q$,
    'diamond_plain_cash_table_required');
  RAISE NOTICE 'PASS: % is still refused at the door', v_case.why;
  PERFORM set_config('request.jwt.claim.role','service_role',false);
  PERFORM set_config('request.jwt.claim.sub','',false);
  EXECUTE format('UPDATE public.tables SET %s WHERE id=%L',v_case.reset,
    '30000000-0000-0000-0000-000000000001');
 END LOOP;
END $cases$;

-- The staff door asks for a caller first and for staff second, and it writes
-- all three columns so the engine composite is exactly the answer it was given.
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','',false);
SELECT fixture_refuses($q$SELECT fn_poker_diamond_set_table_run_it_twice(
 '30000000-0000-0000-0000-000000000001',true)$q$,'authentication required');
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT fixture_refuses($q$SELECT fn_poker_diamond_set_table_run_it_twice(
 '30000000-0000-0000-0000-000000000001',true)$q$,'diamond_table_staff_only');
