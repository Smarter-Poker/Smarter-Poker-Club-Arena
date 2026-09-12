\set ON_ERROR_STOP on
-- A DIAMOND TABLE MAY STRADDLE, AND THE SIDE BET NEXT TO IT STILL MAY NOT.
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);

-- Straddles on. Every other optional column stays exactly as the table was
-- opened, which is what makes this a test of one clause rather than of a row.
UPDATE public.tables SET straddle_enabled=true, voluntary_straddle=true
 WHERE id='30000000-0000-0000-0000-000000000001';
SELECT fixture_assert((SELECT straddle_enabled AND voluntary_straddle AND NOT coalesce(auto_utg_straddle,false)
  FROM public.tables WHERE id='30000000-0000-0000-0000-000000000001'),
 'the fixture table straddles voluntarily and nothing else changed');

SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT set_config('request.jwt.claims','{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000001"}',false);
SELECT atomic_table_buyin('10000000-0000-0000-0000-000000000001',
 '30000000-0000-0000-0000-000000000001',1,100,false,'20000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000011');
SELECT fixture_assert((SELECT count(*)=1 FROM public.table_seats WHERE left_at IS NULL)
 AND (SELECT count(*)=1 FROM public.poker_diamond_custody WHERE state='active' AND balance=100),
 'a straddling Diamond table admits a seat and funds it from custody');

-- Auto UTG is the other straddle column and is admitted too.
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);
UPDATE public.tables SET voluntary_straddle=false, auto_utg_straddle=true
 WHERE id='30000000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',false);
SELECT atomic_table_buyin('10000000-0000-0000-0000-000000000002',
 '30000000-0000-0000-0000-000000000001',2,100,false,'20000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000012');
SELECT fixture_assert((SELECT count(*)=2 FROM public.table_seats WHERE left_at IS NULL),
 'a mandatory UTG straddle is admitted on the same terms');

-- EVERYTHING ELSE THE BLOCK REFUSED IS STILL REFUSED, which is the whole point
-- of removing three clauses rather than the block. The table check runs second,
-- before the seat-collision check, so an already-seated player is the cheapest
-- caller to ask: the answer is about the TABLE either way.
DO $cases$
DECLARE v_case record;
BEGIN
 FOR v_case IN SELECT * FROM (VALUES
   ('seven_deuce_enabled=true','seven_deuce_enabled=false','a side bet beside the straddle'),
   ('run_it_twice=NULL','run_it_twice=false','an unset run-it column'),
   ('allow_run_it_twice=NULL','allow_run_it_twice=false','an unset allow-run-it column'),
   ('rake_cap_bb=NULL','rake_cap_bb=0','an unset rake cap, whose absent value is the published schedule cap'),
   ('bbj_percent=NULL','bbj_percent=0','an unset jackpot percentage, whose absent value reads as 100')
 ) AS t(mutation,reset,why) LOOP
  EXECUTE format('UPDATE public.tables SET %s WHERE id=%L',v_case.mutation,
    '30000000-0000-0000-0000-000000000001');
  PERFORM set_config('request.jwt.claim.role','authenticated',false);
  PERFORM set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
  PERFORM public.fixture_refuses($q$SELECT atomic_table_buyin(
    '10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',3,100,false,
    '20000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000013')$q$,
    'diamond_plain_cash_table_required');
  RAISE NOTICE 'PASS: % is still refused at the door', v_case.why;
  PERFORM set_config('request.jwt.claim.role','service_role',false);
  PERFORM set_config('request.jwt.claim.sub','',false);
  EXECUTE format('UPDATE public.tables SET %s WHERE id=%L',v_case.reset,
    '30000000-0000-0000-0000-000000000001');
 END LOOP;
END $cases$;

-- The staff door asks for a caller first and for staff second. This fixture's
-- fn_is_platform_admin() stand-in says nobody is staff, which is the honest
-- shape: the authority itself is certified by its own tests, and what is being
-- proved here is that this door asks it at all.
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','',false);
SELECT fixture_refuses($q$SELECT fn_poker_diamond_set_table_straddle(
 '30000000-0000-0000-0000-000000000001',true,false)$q$,'authentication required');
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT fixture_refuses($q$SELECT fn_poker_diamond_set_table_straddle(
 '30000000-0000-0000-0000-000000000001',true,false)$q$,'diamond_table_staff_only');
