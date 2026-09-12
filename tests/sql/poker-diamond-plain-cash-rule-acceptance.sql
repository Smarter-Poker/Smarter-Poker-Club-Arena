-- ONE RULE SAYS WHAT A PLAIN DIAMOND CASH TABLE IS, certified in the isolated
-- Phase 6 fixture. Never production.
--
-- The rule had drifted into five rules across five functions. What is asserted
-- here is not that each door has the right list, which is what drifted, but
-- that there is only ONE list and that each door reads it.
\set ON_ERROR_STOP on
\timing off

BEGIN;

-- The fixture's platform-admin check is a constant `false`, so a staff door can
-- only ever answer 'staff only' there. Swap it, inside this transaction, for
-- one that reads a setting: the rule under test is what the door does AFTER it
-- has accepted the caller, and that is unreachable otherwise.
CREATE OR REPLACE FUNCTION public.fn_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.admin',true)::boolean,false) $$;
SELECT set_config('test.admin','true',true);
SELECT set_config('request.jwt.claim.sub','40000000-0000-0000-0000-000000000009',true);

CREATE TEMP TABLE result(check_name text, ok boolean, detail text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.expect(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN INSERT INTO result VALUES (p_name, coalesce(p_ok,false), p_detail); END $$;

-- A door's refusal, as a word, so a test can assert WHICH refusal it got.
CREATE OR REPLACE FUNCTION pg_temp.refusal(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'no_refusal';
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;

-- ===========================================================================
-- A. THE RULE ITSELF, one row per way a table can be wrong or right.
-- ===========================================================================
DO $do$
DECLARE
  v_t public.tables%ROWTYPE;
  v_case record;
BEGIN
  SELECT * INTO v_t FROM public.tables WHERE id='30000000-0000-0000-0000-000000000001';
  /* The baseline is CONSTRUCTED, not inherited. The fixture's row carries
     `insurance_enabled` true from an earlier suite, and a baseline that is not
     plain cash makes every positive case fail for a reason that has nothing to
     do with the rule under test. */
  v_t.game_variant:='nlh'; v_t.tournament_id:=NULL; v_t.cluster_id:=NULL;
  v_t.is_template:=false; v_t.status:='waiting';
  v_t.rake_percent:=0; v_t.rake_cap_bb:=0; v_t.bbj_percent:=0;
  v_t.insurance_enabled:=false;
  v_t.run_it_twice:=false; v_t.allow_run_it_twice:=false;
  v_t.seven_deuce_enabled:=false; v_t.nit_game:=false;
  v_t.all_in_or_fold:=false; v_t.pineapple_holdem:=false; v_t.cap_enabled:=false;
  v_t.straddle_enabled:=false; v_t.bomb_pot_enabled:=false;
  IF NOT public.fn_poker_diamond_plain_cash_table(v_t) THEN
    RAISE EXCEPTION 'plain cash rule: the constructed baseline is not plain cash';
  END IF;

  FOR v_case IN
    SELECT * FROM (VALUES
      ('a plain table',                     'baseline',            true),
      ('a permitted straddle',              'straddle',            true),
      ('permitted run it twice',            'rit_on',              true),
      ('a permitted bomb pot',              'bomb_on',             true),
      ('all three permitted features',      'all_three',           true),
      ('an UNSET rake',                     'rake_null',           false),
      ('an UNSET rake cap',                 'cap_null',            false),
      ('an UNSET jackpot percentage',       'bbj_null',            false),
      ('an UNSET run it twice column',      'rit_null',            false),
      ('an UNSET allow run it twice',       'allow_null',          false),
      ('a rake',                            'rake_set',            false),
      ('insurance',                         'insurance',           false),
      ('a cluster',                         'cluster',             false),
      ('a tournament',                      'tournament',          false),
      ('a template',                        'template',            false),
      ('a closed table',                    'closed',              false),
      /* plo4 moved from refused to admitted on 2026-09-12, and the case moved
         with it rather than being deleted: a game the arena DOES deal is as
         much a part of this matrix as one it does not. The nine are asserted
         one by one in section F. */
      ('a second game',                     'plo4',                true),
      ('a game nobody deals',               'razz',                false),
      ('a cap game',                        'cap',                 false),
      ('seven deuce',                       'seven_deuce',         false),
      ('a nit game',                        'nit',                 false),
      ('all in or fold',                    'aof',                 false),
      ('pineapple',                         'pineapple',           false)
    ) AS c(label, key, expected)
  LOOP
    DECLARE v_row public.tables%ROWTYPE := v_t; v_got boolean;
    BEGIN
      CASE v_case.key
        WHEN 'baseline'     THEN NULL;
        WHEN 'straddle'     THEN v_row.straddle_enabled:=true; v_row.voluntary_straddle:=true;
        WHEN 'rit_on'       THEN v_row.run_it_twice:=true; v_row.allow_run_it_twice:=true;
        WHEN 'bomb_on'      THEN v_row.bomb_pot_enabled:=true;
        WHEN 'all_three'    THEN v_row.straddle_enabled:=true; v_row.run_it_twice:=true;
                                 v_row.allow_run_it_twice:=true; v_row.bomb_pot_enabled:=true;
        WHEN 'rake_null'    THEN v_row.rake_percent:=NULL;
        WHEN 'cap_null'     THEN v_row.rake_cap_bb:=NULL;
        WHEN 'bbj_null'     THEN v_row.bbj_percent:=NULL;
        WHEN 'rit_null'     THEN v_row.run_it_twice:=NULL;
        WHEN 'allow_null'   THEN v_row.allow_run_it_twice:=NULL;
        WHEN 'rake_set'     THEN v_row.rake_percent:=5;
        WHEN 'insurance'    THEN v_row.insurance_enabled:=true;
        WHEN 'cluster'      THEN v_row.cluster_id:='50000000-0000-0000-0000-000000000099';
        WHEN 'tournament'   THEN v_row.tournament_id:='50000000-0000-0000-0000-000000000098';
        WHEN 'template'     THEN v_row.is_template:=true;
        WHEN 'closed'       THEN v_row.status:='closed';
        WHEN 'plo4'         THEN v_row.game_variant:='plo4';
        WHEN 'razz'         THEN v_row.game_variant:='razz';
        WHEN 'cap'          THEN v_row.cap_enabled:=true;
        WHEN 'seven_deuce'  THEN v_row.seven_deuce_enabled:=true;
        WHEN 'nit'          THEN v_row.nit_game:=true;
        WHEN 'aof'          THEN v_row.all_in_or_fold:=true;
        WHEN 'pineapple'    THEN v_row.pineapple_holdem:=true;
      END CASE;
      v_got := public.fn_poker_diamond_plain_cash_table(v_row);
      PERFORM pg_temp.expect(
        'the rule admits ' || v_case.label,
        v_got IS NOT DISTINCT FROM v_case.expected,
        'expected ' || v_case.expected || ', got ' || coalesce(v_got::text,'NULL'));
    END;
  END LOOP;
END $do$;

-- ===========================================================================
-- B. EVERY DOOR READS IT, and none keeps a copy.
-- ===========================================================================
DO $do$
DECLARE v_name text; v_def text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'fn_poker_diamond_buyin',
    'fn_poker_diamond_set_table_straddle',
    'fn_poker_diamond_set_table_run_it_twice',
    'fn_poker_diamond_set_table_bomb_pot'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=v_name AND p.prokind='f';
    PERFORM pg_temp.expect(v_name || ' reads the one rule',
      v_def LIKE '%fn_poker_diamond_plain_cash_table(%');
    PERFORM pg_temp.expect(v_name || ' keeps no copy of the rule',
      v_def NOT LIKE '%game_variant IS DISTINCT%');
  END LOOP;

  -- The settler must NOT read it: by settlement the hand is dealt, and
  -- refusing a dealt hand on a feature flag parks the table.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_poker_diamond_settle_cash_hand';
  PERFORM pg_temp.expect('the settler refuses no dealt hand on a feature flag',
    v_def NOT LIKE '%fn_poker_diamond_plain_cash_table(%');
END $do$;

-- ===========================================================================
-- C. THE STAFF DOORS NO LONGER EXCLUDE EACH OTHER.
--    Each of these was refused before this migration.
-- ===========================================================================
-- Same reason as the constructed baseline above: the fixture's row is not
-- plain cash as it stands, so it is made plain before the doors are asked.
UPDATE public.tables SET
  game_variant='nlh', tournament_id=NULL, cluster_id=NULL, is_template=false,
  status='waiting', rake_percent=0, rake_cap_bb=0, bbj_percent=0,
  insurance_enabled=false, run_it_twice=false, allow_run_it_twice=false,
  run_it_twice_enabled=false, seven_deuce_enabled=false, nit_game=false,
  all_in_or_fold=false, pineapple_holdem=false, cap_enabled=false,
  straddle_enabled=false, voluntary_straddle=false, auto_utg_straddle=false,
  bomb_pot_enabled=true
 WHERE id='30000000-0000-0000-0000-000000000001';
DO $do$ DECLARE r text; BEGIN
  r := pg_temp.refusal($$SELECT public.fn_poker_diamond_set_table_straddle(
    '30000000-0000-0000-0000-000000000001'::uuid, true)$$);
  PERFORM pg_temp.expect('a straddle may be turned on at a table that bombs', r='no_refusal', r);
END $do$;
DO $do$ DECLARE r text; BEGIN
  r := pg_temp.refusal($$SELECT public.fn_poker_diamond_set_table_run_it_twice(
    '30000000-0000-0000-0000-000000000001'::uuid, true)$$);
  PERFORM pg_temp.expect('run it twice may be turned on at a table that bombs', r='no_refusal', r);
END $do$;
DO $do$ DECLARE r text; BEGIN
  r := pg_temp.refusal($$SELECT public.fn_poker_diamond_set_table_straddle(
    '30000000-0000-0000-0000-000000000001'::uuid, true)$$);
  PERFORM pg_temp.expect('a straddle may be turned on at a table that runs it twice', r='no_refusal', r);
END $do$;
SELECT pg_temp.expect('and all three are on together afterwards',
  (SELECT straddle_enabled AND run_it_twice AND bomb_pot_enabled
     FROM public.tables WHERE id='30000000-0000-0000-0000-000000000001'));

-- ===========================================================================
-- D. AND THEY REFUSE WHAT THE MONEY DOOR WOULD REFUSE AFTERWARDS.
--    A staff door tests the row it is ABOUT TO WRITE, so an unset column it
--    does not write is a refusal even though the door never reads that column
--    for its own purpose.
-- ===========================================================================
UPDATE public.tables SET bomb_pot_enabled=false, straddle_enabled=false,
  voluntary_straddle=false, auto_utg_straddle=false,
  run_it_twice=false, allow_run_it_twice=false, rake_cap_bb=NULL
 WHERE id='30000000-0000-0000-0000-000000000001';
SELECT pg_temp.expect('an unset rake cap refuses the straddle door',
  pg_temp.refusal($$SELECT public.fn_poker_diamond_set_table_straddle(
    '30000000-0000-0000-0000-000000000001'::uuid, true)$$) LIKE '%plain_cash_table_required%');
SELECT pg_temp.expect('an unset rake cap refuses the run it twice door',
  pg_temp.refusal($$SELECT public.fn_poker_diamond_set_table_run_it_twice(
    '30000000-0000-0000-0000-000000000001'::uuid, true)$$) LIKE '%plain_cash_table_required%');
SELECT pg_temp.expect('an unset rake cap refuses the bomb pot door',
  pg_temp.refusal($$SELECT public.fn_poker_diamond_set_table_bomb_pot(
    '30000000-0000-0000-0000-000000000001'::uuid, true, 2, 1::smallint)$$) LIKE '%plain_cash_table_required%');

UPDATE public.tables SET rake_cap_bb=0, run_it_twice=NULL WHERE id='30000000-0000-0000-0000-000000000001';
SELECT pg_temp.expect('an unset run it twice column refuses the straddle door',
  pg_temp.refusal($$SELECT public.fn_poker_diamond_set_table_straddle(
    '30000000-0000-0000-0000-000000000001'::uuid, true)$$) LIKE '%plain_cash_table_required%');
-- The run-it-twice door WRITES that column, so it is the one door an unset
-- run-it column does not refuse: it is about to state it.
DO $do$ DECLARE r text; BEGIN
  r := pg_temp.refusal($$SELECT public.fn_poker_diamond_set_table_run_it_twice(
    '30000000-0000-0000-0000-000000000001'::uuid, true)$$);
  PERFORM pg_temp.expect('the run it twice door states the column it is asked about', r='no_refusal', r);
END $do$;

-- ===========================================================================
-- E. THE MONEY DOOR'S BEHAVIOUR IS UNCHANGED WHERE IT MATTERS.
-- ===========================================================================
UPDATE public.tables SET rake_cap_bb=NULL, run_it_twice=false, allow_run_it_twice=false,
  straddle_enabled=false, bomb_pot_enabled=false, voluntary_straddle=false,
  auto_utg_straddle=false, run_it_twice_enabled=false
 WHERE id='30000000-0000-0000-0000-000000000001';
DO $do$ DECLARE r text; BEGIN
  r := pg_temp.refusal($$SELECT public.fn_poker_diamond_buyin(
    '40000000-0000-0000-0000-000000000001'::uuid,
    '30000000-0000-0000-0000-000000000001'::uuid, 1, 100, false,
    '20000000-0000-0000-0000-000000000001'::uuid,
    '70000000-0000-0000-0000-0000000000f1'::uuid)$$);
  PERFORM pg_temp.expect('the buy-in door still refuses an unset rake cap',
    r LIKE '%plain_cash_table_required%', r);
END $do$;

-- ===========================================================================
-- F. THE GAMES THIS ARENA DEALS, and the one list that names them.
-- ===========================================================================
DO $do$
DECLARE
  v_t public.tables%ROWTYPE;
  v_game text;
BEGIN
  SELECT * INTO v_t FROM public.tables WHERE id='30000000-0000-0000-0000-000000000001';
  v_t.game_variant:='nlh'; v_t.tournament_id:=NULL; v_t.cluster_id:=NULL;
  v_t.is_template:=false; v_t.status:='waiting';
  v_t.rake_percent:=0; v_t.rake_cap_bb:=0; v_t.bbj_percent:=0;
  v_t.insurance_enabled:=false;
  v_t.run_it_twice:=false; v_t.allow_run_it_twice:=false;
  v_t.seven_deuce_enabled:=false; v_t.nit_game:=false;
  v_t.all_in_or_fold:=false; v_t.pineapple_holdem:=false; v_t.cap_enabled:=false;

  FOREACH v_game IN ARRAY ARRAY['nlh','plo4','plo5','plo6','plo8','pineapple',
                                'short_deck','flh','flo8'] LOOP
    DECLARE v_row public.tables%ROWTYPE := v_t;
    BEGIN
      v_row.game_variant:=v_game;
      PERFORM pg_temp.expect('the arena deals ' || v_game,
        public.fn_poker_diamond_cash_variant(v_game)
          AND public.fn_poker_diamond_plain_cash_table(v_row));
    END;
  END LOOP;

  FOREACH v_game IN ARRAY ARRAY['razz','stud','badugi','NLH','PLO4','holdem',''] LOOP
    DECLARE v_row public.tables%ROWTYPE := v_t;
    BEGIN
      v_row.game_variant:=v_game;
      PERFORM pg_temp.expect('the arena does not deal ' || coalesce(nullif(v_game,''),'(blank)'),
        NOT public.fn_poker_diamond_cash_variant(v_game)
          AND NOT public.fn_poker_diamond_plain_cash_table(v_row));
    END;
  END LOOP;

  DECLARE v_row public.tables%ROWTYPE := v_t;
  BEGIN
    v_row.game_variant:=NULL;
    PERFORM pg_temp.expect('a table with no game at all is refused',
      NOT public.fn_poker_diamond_plain_cash_table(v_row));
  END;
END $do$;

-- Every door that names a game names it through the one list, so a tenth game
-- is added in one place rather than found in four.
DO $do$
DECLARE v_name text; v_def text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['fn_poker_diamond_plain_cash_table',
                                'fn_poker_diamond_settle_cash_hand'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=v_name AND p.prokind='f';
    PERFORM pg_temp.expect(v_name || ' names its games through the one list',
      v_def IS NOT NULL AND v_def LIKE '%fn_poker_diamond_cash_variant(%');
    PERFORM pg_temp.expect(v_name || ' keeps no literal game of its own',
      v_def IS NOT NULL AND v_def NOT LIKE '%game_variant=''nlh''%'
                        AND v_def NOT LIKE '%game_variant = ''nlh''%');
  END LOOP;
END $do$;

-- ===========================================================================
SELECT check_name, ok, detail FROM result ORDER BY check_name;
DO $do$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM result WHERE NOT ok;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'plain cash rule: % check(s) failed', v_bad;
  END IF;
  RAISE NOTICE 'plain cash rule: all % checks passed', (SELECT count(*) FROM result);
END $do$;

ROLLBACK;
