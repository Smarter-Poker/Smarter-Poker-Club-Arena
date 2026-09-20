-- 20260919220610_diamond_bonus_games_have_one_setting_and_super_guarantees_the_entry.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan, 2026-09-19):
--   "All upgraded games need to say Super + game title. They must all pay a
--    minimum of 1:1 value even if they lose and don't cash out. That should be
--    displayed before they even start the game."
--   "Users should not select difficulty. One setting that is already built into
--    the payout and math."
--
-- 1. THE SUPER GUARANTEE. fn_diamond_bonus_minimum(p_bet, p_boost): a Super award
--    (boost 2, a doubled stake) returns at least HALF its funded stake on any loss
--    or un-cashed round. Half of a doubled stake is the spin entry, so a Super game
--    pays at least 1:1 of what the spin cost. Ordinary play keeps its 10% floor.
--    The survival law is untouched: P(reach target) = (0.8B - L)/(target - L), so
--    every stopping target still carries expectation 0.8B whatever L is, and Mines
--    prizes stay L + (0.8B - L)/survival. The wheel's 0.80 model is unchanged.
-- 2. ONE PLINKO TABLE PER STAKE KIND, TEN DROPS PER GAME. Dan played twenty
--    2,500-diamond Plinko awards on the Steady table, never cleared 21 chips and
--    never saw a 5x, 10x or 20x. The maths was right and the calibration was
--    wrong: at 1-5 diamonds a drop a 2,500-diamond award is 500-2,500 drops, and
--    the average of that many drops is 0.80 give or take three hundredths, so the
--    game could only ever return about 20 chips. A 20x slot at 1 in 65,536 drops
--    was a label, not a prize. Two things change:
--      a. Every game is exactly ten drops of a tenth of the entry. Nobody chooses
--         a drop value; fn_plinko_bonus_run refuses any other split.
--      b. A new ordinary table, Diamond (v5): 20x on the three outer slots each
--         side (1 drop in 239), 12x (1 in 59), 5x (1 in 18), then 0.60x, 0.35x,
--         0.15x and 0.08x in the middle. Exact 0.800000 return, top 20x. Over
--         ten drops a game returns at least its entry 28% of the time, at least
--         double 6.8%, and sees a 5x-or-better drop 55% of the time, a 12x 19%,
--         a 20x 4%.
--    A Super table (v4) for Super awards: 20x, 20x, 15x, 7.5x, 1.75x, then 0.64x,
--    0.56x, 0.53x and 0.52x. Its LOWEST slot is 0.52x, above the 0.50x that is
--    the spin entry on a doubled stake, so every Super batch returns at least
--    1:1 through the multipliers themselves, and the table still audits to
--    exactly 0.800000. Both tops are exactly 20.00x: the batch cover guard rounds
--    each drop's maximum up to a whole cent, and 20x is whole cents at every
--    drop size. A Super batch floor at 0.50x makes the guarantee exact for
--    sub-cent drops. Steady, Bold and Moonshot close; their settled batches keep
--    their receipts. Nobody chooses a table: fn_plinko_table_version(boost) does.
-- 3. ONE ROAD. fn_choice_ladder('road'): twelve streets 1.10x -> 20.00x. 20x is
--    inside every award cap (40x/20x ordinary, 30x/20x Super), so all twelve
--    streets are always open. The three risk ladders stay readable for settled
--    rounds and their replays; no new round may name them.
-- 4. ONE MINE COUNT. Six mines in twenty-five tiles. The first gem pays 1.02x on
--    an ordinary award; twelve gems in a row reach the 40x cap.
-- 5. fn_choice_start refuses any mode but the one setting. fn_choice_state and
--    fn_wheel_bonus_state quote with it, and fn_wheel_bonus_state now returns
--    the exact minimum and table the award will start with, so the client shows
--    the server's guarantee before Start rather than a mirror.
-- 6. payout_version 3 marks a round sealed with the Super floor, so receipts can
--    tell the two contracts apart without a new column.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- The exact bodies this migration replaces or patches, as read from production
-- on 2026-09-19. Any drift means a sibling change landed first: stop and re-read.
DO $$
DECLARE expected record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('fn_diamond_bonus_minimum(numeric)','387403440eb8c3edb84d984740356d48'),
  ('fn_choice_prizes(text,text,numeric)','5c203550c6f189fff071d2830938e208'),
  ('fn_choice_ladder(text)','d5cf37846ddedc2321522bac88555063'),
  ('fn_choice_board(text,text,bigint,integer)','64170db87fafbb1b3b8489cf784e9127'),
  ('fn_choice_start(uuid,text,text,integer,uuid,text,integer)','4b18c820aa5b2905ae95487cf2e0ae05'),
  ('fn_choice_state(uuid,text,text,integer)','887386f78e30e1badf266047e35d250d'),
  ('fn_choice_result(diamond_choice_rounds)','76691836f8999b15d9cbec12cc927760'),
  ('fn_crash_start(uuid,uuid,text,integer,integer)','47fa15a9e8af963636ea77f495db1044'),
  ('fn_crash_round_result(crash_rounds)','bf441cdc74d99cae5228c448e0359705'),
  ('fn_wheel_bonus_state(uuid,text,boolean,text,uuid)','caa55c29e49a67feb1f0006e11d7b37e'),
  ('fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)','1b5020f0d055fd1050ba63f28140ae5f')
 ) x(signature,body_hash) LOOP
  IF md5(pg_get_functiondef(to_regprocedure('public.'||expected.signature))) IS DISTINCT FROM expected.body_hash THEN
   RAISE EXCEPTION 'Diamond One Setting Preimage Changed: %',expected.signature;
  END IF;
 END LOOP;
END $$;

-- 1. The guaranteed minimum knows the stake kind. Half a doubled stake is the entry.
DROP FUNCTION public.fn_diamond_bonus_minimum(numeric);
CREATE FUNCTION public.fn_diamond_bonus_minimum(p_bet numeric, p_boost integer DEFAULT 1)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE WHEN p_boost=2 THEN ceil(p_bet*50)/100 ELSE ceil(p_bet*10)/100 END
$$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_minimum(numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_minimum(numeric,integer) TO service_role;

-- 2. One setting per game, named in one place each.
CREATE FUNCTION public.fn_choice_mode(p_game text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE p_game WHEN 'crossing' THEN 'road' WHEN 'mines' THEN '6' END
$$;
REVOKE ALL ON FUNCTION public.fn_choice_mode(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_mode(text) TO service_role;

CREATE FUNCTION public.fn_plinko_table_version(p_boost integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE WHEN p_boost=2 THEN 4 ELSE 5 END
$$;
REVOKE ALL ON FUNCTION public.fn_plinko_table_version(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_plinko_table_version(integer) TO service_role;

-- 3. One road. The three risk ladders stay readable for sealed rounds and replays.
CREATE OR REPLACE FUNCTION public.fn_choice_ladder(p_mode text) RETURNS integer[]
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE p_mode
 WHEN 'road' THEN ARRAY[110,145,185,245,315,410,535,700,910,1180,1540,2000]
 WHEN 'steady' THEN ARRAY[110,135,170,215,275,355,460,600,800,1100,1600,2400]
 WHEN 'bold' THEN ARRAY[150,220,330,500,800,1300,2200,4000,7500,15000]
 WHEN 'extreme' THEN ARRAY[200,400,800,1600,3200,6400,12800,25600] END
$$;

-- 4. Six mines. Sealed boards of five, ten and fifteen keep verifying.
CREATE OR REPLACE FUNCTION public.fn_choice_board(p_server text, p_client text, p_nonce bigint, p_mines integer)
RETURNS integer[] LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public', 'extensions' AS $function$
DECLARE cells integer[]:=ARRAY(SELECT generate_series(0,24)); i integer; j integer; temp integer; cursor integer:=0; v bigint; lim bigint; out integer[];
BEGIN
 IF p_mines NOT IN (5,6,10,15) THEN RAISE EXCEPTION 'Choose A Mine Count'; END IF;
 FOR i IN REVERSE 25..2 LOOP
  lim:=(4294967296::bigint/i)*i;
  LOOP
   v:=('x'||substr(encode(extensions.hmac(p_client||':'||p_nonce||':board:'||cursor,p_server,'sha256'),'hex'),1,8))::bit(32)::bigint;
   cursor:=cursor+1; EXIT WHEN v<lim;
  END LOOP;
  j:=(v%i)::integer+1; temp:=cells[i]; cells[i]:=cells[j]; cells[j]:=temp;
 END LOOP;
 SELECT array_agg(x ORDER BY x) INTO out FROM unnest(cells[1:p_mines]) x;
 RETURN out;
END $function$;

-- Prizes carry the stake kind so a quote and a start agree on the floor.
DROP FUNCTION public.fn_choice_prizes(text,text,numeric);
CREATE FUNCTION public.fn_choice_prizes(p_game text, p_mode text, p_bet numeric, p_boost integer DEFAULT 1)
RETURNS numeric[] LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $function$
DECLARE out numeric[]:='{}'; ladder integer[]; m integer; k integer; floor_chips numeric;
BEGIN
 floor_chips:=public.fn_diamond_bonus_minimum(p_bet,p_boost);
 IF p_game='crossing' THEN
  ladder:=public.fn_choice_ladder(p_mode);
  IF ladder IS NULL THEN RAISE EXCEPTION 'Choose A Road Difficulty'; END IF;
  FOR k IN 1..cardinality(ladder) LOOP out:=array_append(out,p_bet*ladder[k]/100); END LOOP;
 ELSIF p_game='mines' AND p_mode IN ('5','6','10','15') THEN
  m:=p_mode::integer;
  FOR k IN 1..25-m LOOP out:=array_append(out,floor_chips+(p_bet*0.8-floor_chips)*public.fn_choice_choose(25,k)/public.fn_choice_choose(25-m,k)); END LOOP;
 ELSE RAISE EXCEPTION 'Choose A Game Setting'; END IF;
 RETURN out;
END $function$;
REVOKE ALL ON FUNCTION public.fn_choice_prizes(text,text,numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_prizes(text,text,numeric,integer) TO service_role;

-- 5. The two Plinko tables. Both exact 0.800000, both top exactly 20x, every slot pays.
--    Sixteen rows: a drop lands in slot k with probability C(16,k)/65536, so the three
--    outer slots each side are 137 in 65,536 together, the next 560, the next 1,820.
INSERT INTO public.plinko_tables(version,name,board_rows,multipliers_cents,max_multiplier_cents,note)
VALUES
 (4,'Super',16,ARRAY[2000,2000,1500,750,175,64,56,53,52,53,56,64,175,750,1500,2000,2000],2000,
  'Super awards only. The lowest slot is 0.52x, above the 0.50x that is the spin entry on a doubled stake, so every batch returns at least 1:1. Exact 0.800000 return, every slot pays, top 20x.'),
 (5,'Diamond',16,ARRAY[2000,2000,2000,1200,500,60,35,15,8,15,35,60,500,1200,2000,2000,2000],2000,
  'Ordinary awards. 20x on three slots each side (1 drop in 239), 12x (1 in 59), 5x (1 in 18). Exact 0.800000 return over ten drops a game, every slot pays, top 20x.');
DO $$
DECLARE a record; v integer;
BEGIN
 FOREACH v IN ARRAY ARRAY[4,5] LOOP
  SELECT x.* INTO a FROM public.fn_plinko_table_audit(v) x;
  IF a.spec_rtp IS DISTINCT FROM 0.800000 OR a.max_multiplier_cents IS DISTINCT FROM 2000 OR a.hit_rate IS DISTINCT FROM 1.000000 OR a.slots IS DISTINCT FROM 17 THEN
   RAISE EXCEPTION 'Plinko Table % Audit Failed: %',v,to_jsonb(a);
  END IF;
  UPDATE public.plinko_tables SET spec_rtp=a.spec_rtp,sd_chips=a.sd_chips,hit_rate=a.hit_rate,max_multiplier_cents=a.max_multiplier_cents,activated_at=now() WHERE version=v;
 END LOOP;
 -- One table per stake kind. Steady, Bold and Moonshot close; their settled batches keep their receipts.
 UPDATE public.plinko_tables SET activated_at=NULL WHERE version IN (1,2,3);
 IF (SELECT count(*) FROM public.plinko_tables WHERE activated_at IS NOT NULL)<>2
  OR (SELECT count(*) FROM public.plinko_tables WHERE version IN (4,5) AND activated_at IS NOT NULL AND max_multiplier_cents=2000)<>2 THEN
  RAISE EXCEPTION 'Diamond And Super Must Be The Open Plinko Tables';
 END IF;
END $$;

-- 6. Patch the sealed starters, quotes and receipts on their exact preimages.
DO $$
DECLARE original text; needle text; hits integer;
BEGIN
 -- Crash: the crash point and the stored minimum both carry the award's boost.
 SELECT pg_get_functiondef('public.fn_crash_start(uuid,uuid,text,integer,integer)'::regprocedure) INTO original;
 needle:='public.fn_diamond_bonus_minimum(adm.o_bet_chips)';
 hits:=(length(original)-length(replace(original,needle,'')))/length(needle);
 IF hits<>2 THEN RAISE EXCEPTION 'Crash minimum call sites: expected 2, found %',hits; END IF;
 EXECUTE replace(original,needle,'public.fn_diamond_bonus_minimum(adm.o_bet_chips,COALESCE((public.fn_wheel_starting_award()).boost_multiplier,1))');

 -- Crossing and Mines: one setting, boosted prizes and minimum.
 SELECT pg_get_functiondef('public.fn_choice_start(uuid,text,text,integer,uuid,text,integer)'::regprocedure) INTO original;
 needle:=' SELECT * INTO adm FROM public.fn_diamond_game_admit(p_game,p_club_id,p_commit_id,p_client_seed,p_bet);';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice admission insertion point missing'; END IF;
 original:=replace(original,needle,$new$ -- A new round names the one setting. A sealed round above keeps the mode it was dealt.
 IF p_mode IS DISTINCT FROM public.fn_choice_mode(p_game) THEN RETURN jsonb_build_object('ok',false,'error','This Game Has One Setting. Refresh Before You Play'); END IF;
$new$||needle);
 needle:='v_prizes:=public.fn_choice_prizes(p_game,p_mode,adm.o_bet_chips);';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice prize call missing'; END IF;
 original:=replace(original,needle,'v_prizes:=public.fn_choice_prizes(p_game,p_mode,adm.o_bet_chips,COALESCE((public.fn_wheel_starting_award()).boost_multiplier,1));');
 needle:='public.fn_diamond_bonus_minimum(adm.o_bet_chips)) RETURNING * INTO r;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice minimum insertion point missing'; END IF;
 original:=replace(original,needle,'public.fn_diamond_bonus_minimum(adm.o_bet_chips,COALESCE((public.fn_wheel_starting_award()).boost_multiplier,1))) RETURNING * INTO r;');
 EXECUTE original;

 -- Quotes without an award use the one setting.
 SELECT pg_get_functiondef('public.fn_choice_state(uuid,text,text,integer)'::regprocedure) INTO original;
 needle:='prizes:=public.fn_choice_prizes(p_game,p_mode,p_bet::numeric/rate);';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice state quote missing'; END IF;
 EXECUTE replace(original,needle,'prizes:=public.fn_choice_prizes(p_game,public.fn_choice_mode(p_game),p_bet::numeric/rate);');

 -- Award quotes use the one setting and the award''s boost, and say what the start will use.
 SELECT pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure) INTO original;
 needle:='v_state:=public.fn_choice_state(p_club_id,p_game,COALESCE(p_mode,CASE WHEN p_game=''mines'' THEN ''5'' ELSE ''steady'' END),100);';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Bonus state choice quote missing'; END IF;
 original:=replace(original,needle,'v_state:=public.fn_choice_state(p_club_id,p_game,public.fn_choice_mode(p_game),100);');
 needle:='prizes:=public.fn_choice_prizes(p_game,COALESCE(p_mode,CASE WHEN p_game=''mines'' THEN ''5'' ELSE ''steady'' END),total::numeric/rate);';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Bonus state award quote missing'; END IF;
 original:=replace(original,needle,'prizes:=public.fn_choice_prizes(p_game,public.fn_choice_mode(p_game),total::numeric/rate,a.boost_multiplier);');
 needle:='''bets'',jsonb_build_array(jsonb_build_object(''bet_diamonds'',total,''bet_chips'',total::numeric/rate,''cap_cents'',cap,''playable'',cap>=101)));';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Bonus state bets insertion point missing'; END IF;
 original:=replace(original,needle,needle||$new$
  -- What this award starts with, from the server, so the client can show the guarantee before Start.
  v_state:=v_state||jsonb_build_object('mode',public.fn_choice_mode(p_game),'plinko_table',public.fn_plinko_table_version(a.boost_multiplier),
   'minimum_payout_chips',public.fn_diamond_bonus_minimum(total::numeric/rate,a.boost_multiplier),'guarantee',CASE WHEN a.boost_multiplier=2 THEN 'super' ELSE 'standard' END);
$new$);
 EXECUTE original;

 -- Receipts: version 3 is a round sealed with the Super floor.
 needle:='''payout_version'',CASE WHEN r.minimum_payout_chips>0 THEN 2 ELSE 1 END';
 SELECT pg_get_functiondef('public.fn_choice_result(diamond_choice_rounds)'::regprocedure) INTO original;
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice payout version missing'; END IF;
 EXECUTE replace(original,needle,'''payout_version'',CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END');
 SELECT pg_get_functiondef('public.fn_crash_round_result(crash_rounds)'::regprocedure) INTO original;
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash payout version missing'; END IF;
 EXECUTE replace(original,needle,'''payout_version'',CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END');

 -- Plinko: the table follows the stake kind; a Super batch returns at least the entry.
 SELECT pg_get_functiondef('public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)'::regprocedure) INTO original;
 needle:='DECLARE adm record; t public.plinko_tables;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Plinko declare block missing'; END IF;
 original:=replace(original,needle,'DECLARE adm record; t public.plinko_tables; v_boost integer; v_minimum numeric:=0;');
 needle:=' IF p_denom IS NULL OR p_denom NOT IN (1,2,4,5,10,20,25,50,100) OR p_total%p_denom<>0 THEN
  RETURN jsonb_build_object(''ok'',false,''error'',''Choose A Drop Value That Uses Every Diamond''); END IF;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Plinko drop value check missing'; END IF;
 original:=replace(original,needle,$new$ -- Ten drops, always: the drop value is a tenth of the entry, and nobody chooses it.
 -- Admission below keeps entries to whole chips, so a tenth is always whole diamonds.
 IF p_total IS NULL OR p_total%10<>0 OR p_denom IS DISTINCT FROM p_total/10 THEN
  RETURN jsonb_build_object('ok',false,'error','Plinko Plays Ten Drops. Refresh Before You Play'); END IF;$new$);
 needle:=' SELECT * INTO t FROM public.plinko_tables WHERE version=p_table AND activated_at IS NOT NULL;
 IF NOT FOUND THEN RETURN jsonb_build_object(''ok'',false,''error'',''Choose An Available Plinko Table''); END IF;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Plinko table lookup missing'; END IF;
 original:=replace(original,needle,$new$ -- One table per stake kind. The client names it too, and a receipt that disagrees is refused there.
 v_boost:=COALESCE((public.fn_wheel_starting_award()).boost_multiplier,1);
 SELECT * INTO t FROM public.plinko_tables WHERE version=public.fn_plinko_table_version(v_boost) AND activated_at IS NOT NULL;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','The Plinko Table Is Not Open'); END IF;
 IF p_table IS NOT NULL AND p_table<>t.version THEN RETURN jsonb_build_object('ok',false,'error','Plinko Has One Table. Refresh Before You Play'); END IF;$new$);
 needle:=' debit:=public.fn_diamond_game_take_bet(auth.uid(),p_total,(adm.o_cfg).purchased_only,''plinko_drop'',';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Plinko debit insertion point missing'; END IF;
 original:=replace(original,needle,$new$ -- Super: the batch returns at least half its doubled stake, the spin entry, whatever the
 -- sealed drops and their cent rounding did. The table already averages 0.80.
 IF v_boost=2 THEN v_minimum:=public.fn_diamond_bonus_minimum(adm.o_bet_chips,2); paid:=GREATEST(paid,v_minimum); END IF;
$new$||needle);
 needle:='''drops'',to_jsonb(balls),''payout_chips'',paid,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Plinko result insertion point missing'; END IF;
 original:=replace(original,needle,'''drops'',to_jsonb(balls),''payout_chips'',paid,''minimum_payout_chips'',v_minimum,''payout_version'',CASE WHEN v_boost=2 THEN 3 ELSE 1 END,');
 EXECUTE original;
END $$;

-- Read back: the design, as installed.
DO $$
BEGIN
 IF (SELECT count(*) FROM public.plinko_tables WHERE activated_at IS NOT NULL AND version IN (4,5))<>2 THEN RAISE EXCEPTION 'Plinko tables not as designed'; END IF;
 IF (SELECT min(m) FROM public.plinko_tables t, unnest(t.multipliers_cents) m WHERE t.version=4)<>52
  OR (SELECT min(m) FROM public.plinko_tables t, unnest(t.multipliers_cents) m WHERE t.version=5)<>8
  OR (SELECT count(*) FROM public.plinko_tables t, unnest(t.multipliers_cents) m WHERE t.version=5 AND m=2000)<>6 THEN RAISE EXCEPTION 'Plinko multipliers not as designed'; END IF;
 IF public.fn_diamond_bonus_minimum(3,2)<>1.5 OR public.fn_diamond_bonus_minimum(3)<>0.3 OR public.fn_diamond_bonus_minimum(0.25,2)<>0.13 THEN RAISE EXCEPTION 'Minimum rule not as designed'; END IF;
 IF cardinality(public.fn_choice_ladder('road'))<>12 OR (public.fn_choice_ladder('road'))[12]<>2000 THEN RAISE EXCEPTION 'Road not as designed'; END IF;
 IF public.fn_choice_mode('mines')<>'6' OR public.fn_choice_mode('crossing')<>'road' OR public.fn_plinko_table_version(2)<>4 OR public.fn_plinko_table_version(1)<>5 THEN RAISE EXCEPTION 'One setting not as designed'; END IF;
 IF strpos(pg_get_functiondef('public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)'::regprocedure),'p_denom IS DISTINCT FROM p_total/10')=0 THEN RAISE EXCEPTION 'Ten drops not as designed'; END IF;
 IF cardinality(public.fn_choice_prizes('mines','6',1))<>19 OR abs((public.fn_choice_prizes('mines','6',1,2))[1]-(0.5+(0.8-0.5)*25/19.0))>0.000001 THEN RAISE EXCEPTION 'Mines prizes not as designed'; END IF;
END $$;

COMMIT;
