-- Run against an isolated cash_games fixture with the maintained trigger.
-- Exercises the actual PL/pgSQL, never live tables or player money.
\set ON_ERROR_STOP on
BEGIN;
DO $test$
DECLARE
  v_club uuid; v_variant text; v_sb numeric; v_bb numeric; v_enabled boolean;
  v_expected boolean; v_allowed boolean; v_cases integer := 0;
BEGIN
  FOR v_club, v_variant, v_sb, v_bb, v_enabled, v_expected IN
    SELECT * FROM (VALUES
      ('fade0000-0000-0000-0000-000000000001'::uuid,'plo4',2::numeric,5::numeric,true,true),
      ('fade0000-0000-0000-0000-000000000001'::uuid,'plo5',2,5,true,true),
      ('fade0000-0000-0000-0000-000000000001'::uuid,'plo6',2,5,true,true),
      ('fade0000-0000-0000-0000-000000000001'::uuid,'nlh',2,5,true,false),
      ('fade0000-0000-0000-0000-000000000001'::uuid,'plo8',2,5,true,false),
      ('fade0000-0000-0000-0000-000000000001'::uuid,'plo4',1,5,true,false),
      ('fade0000-0000-0000-0000-000000000001'::uuid,'plo4',5,10,true,false),
      ('00000000-0000-0000-0000-000000000002'::uuid,'plo4',2,5,true,false),
      (NULL::uuid,'plo4',2,5,true,false),
      ('fade0000-0000-0000-0000-000000000001'::uuid,NULL::text,2,5,true,false),
      ('00000000-0000-0000-0000-000000000002'::uuid,'nlh',1,2,true,true),
      ('00000000-0000-0000-0000-000000000002'::uuid,'plo4',5,10,false,true)
    ) AS cases(club,variant,sb,bb,enabled,allowed)
  LOOP
    v_allowed := true;
    BEGIN
      INSERT INTO public.cash_games(club_id,variant,sb,bb,enabled)
        VALUES(v_club,v_variant,v_sb,v_bb,v_enabled);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_allowed := false;
    END;
    IF v_allowed IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Wrong stake decision: % % %/% enabled % expected %',
        v_club,v_variant,v_sb,v_bb,v_enabled,v_expected;
    END IF;
    v_cases := v_cases + 1;
  END LOOP;
  BEGIN
    UPDATE public.cash_games SET bb=10 WHERE variant='plo4' AND bb=5 AND enabled;
    RAISE EXCEPTION 'A Midway 2/5 game was allowed to become 2/10';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    UPDATE public.cash_games SET enabled=true WHERE bb=10;
    RAISE EXCEPTION 'A closed game above the cap was allowed to reopen';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  RAISE NOTICE 'PASS: % stake cases and two update refusals', v_cases;
END
$test$;
ROLLBACK;
