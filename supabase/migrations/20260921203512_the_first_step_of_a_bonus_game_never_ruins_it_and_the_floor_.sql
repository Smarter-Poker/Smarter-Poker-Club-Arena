-- 20260921203512_the_first_step_of_a_bonus_game_never_ruins_it_and_the_floor_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan, 2026-09-21, rulings R3, R6, R10, R11, R16):
--   R3  "The first step of a bonus game can never ruin it: the first tile
--        selected in Mines must always be a diamond, never a bomb; the first
--        street (Road crossing) must always be successful; the Crash ship can
--        never explode until after 1.1x."
--   R6  "On Plinko the player must choose how many diamonds to drop and the
--        value of each drop."
--   R10 "Minimum payout when they lose and get nothing goes from 0.10 to 0.50."
--   R11 "Super bonus games are not factoring the double diamond add-on into
--        the minimum payout requirement. A 2,500 diamond spin plus a 2,500
--        diamond add-on must have a minimum payout of 50 chips for any game."
--   R16 The add-on debit must state the amount actually debited.
--
-- Every game keeps its long-run return at EXACTLY 0.80 of the stake. The edge
-- is charged once, and every stopping point a player may choose is still worth
-- 0.8B: L + P(reach) x (prize - L) = 0.8B. A step that is certain (P = 1) can
-- therefore pay only 0.8B, or must not be a cash-out point. Concretely:
--
-- 1. THE FLOOR (payout_version 4). fn_diamond_bonus_floor(bet, boost, paid, rate):
--    an ordinary award keeps HALF its stake on a loss (R10: the constant 10
--    becomes 50); a Super award keeps the greater of half its stake and what
--    the player actually PAID (spin entry + Double Diamonds add-on) at the
--    bridge rate (R11). Without the add-on that is half the doubled stake, the
--    entry, unchanged (25 chips on a 2,500 spin). With the add-on it is two
--    thirds of the stake (50 chips on 2,500 + 2,500, a 7,500 stake). Both are
--    below 0.80 of the stake, so every game remains a 0.80 game; the function
--    clamps a cent under 0.80B and the probe proves the clamp never binds for
--    any reachable stake. Rounded UP to the cent: never in the house's favour.
-- 2. MINES. The first tile is always a diamond. The board is no longer dealt at
--    start: mine_cells is sealed EMPTY and dealt exactly once, at the first
--    pick, by fn_choice_board_v4(server_seed, client_seed, nonce, mines, first
--    cell): a Fisher-Yates shuffle of the twenty-four OTHER cells whose HMAC
--    domain names the first cell, so the receipt reproduces it and the pick
--    could not have been known. fn_choice_immutable admits that one write and
--    only that write (it recomputes the board itself). With a safe first pick
--    P(survive k) = C(18,k-1)/C(24,k-1), so the ladder is re-derived to
--    prize_k = L + (0.8B - L) x C(24,k-1)/C(18,k-1): the first gem pays 0.80B.
-- 3. ROAD. The first street pays 0.80x (ladder [80,145,...,2000]); the survival
--    identity then makes it certain with no special case anywhere: (roll+1) x
--    (0.8B - L) <= (0.8B - L) x 2^48 for every roll. The player still chooses
--    at street one: bank 0.80x or cross street two. Every street is 0.8B.
-- 4. CRASH. The crash point is floored at 1.10x (GREATEST(110, ...)) and cash
--    out opens at 1.11x on rounds sealed under this contract. For any x > 1.10,
--    max(raw,110) >= x iff raw >= x, so P(point >= x) = (0.8B - L)/(xB - L) is
--    unchanged and every cash-out target still returns 0.8B. Old open rounds
--    keep their 1.01x floors: fn_crash_decide reads the round's payout_version.
-- 5. PLINKO. The drop value is the player's again (R6): p_denom in
--    (1,2,4,5,10,20,25,50,100,250,500), dividing the stake exactly, 1 to 100
--    drops; and the whole stake as one drop is always open, so an entry no
--    listed value divides into a hundred drops (2,489 diamonds, say) still has
--    a game to play. The floor applies to the WHOLE run. The table follows the floor,
--    not the boost: every half-floor stake (ordinary, Super without add-on)
--    plays the Super table (v4, lowest slot 0.52x), and a Super stake with the
--    add-on plays the new Super Double table (v6, lowest slot 0.72x), so the
--    multipliers themselves carry the guarantee and the floor is never what
--    pays, up to cent rounding. Diamond (v5, lowest slot 0.08x) closes: no new
--    stake has a floor it can carry. Its settled batches keep their receipts.
-- 6. RECEIPTS. payout_version 4 on diamond_choice_rounds and crash_rounds (a
--    column, NULL for rows sealed before today, whose version is still derived
--    from their floor as before) and in the Plinko result. Nothing sealed
--    before today is repriced.
-- 7. R16. The add-on debit is described as the add-on with the amount actually
--    debited, and its diamond_transactions metadata carries add_on=true,
--    added_diamonds and stake_diamonds, on all four games.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- The exact bodies this migration patches or depends on, as read from production
-- on 2026-09-21. Any drift means a sibling change landed first: stop and re-read.
DO $$
DECLARE expected record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('fn_diamond_bonus_minimum(numeric,integer)','741893f7c0bd2ec892cd8bd7b1075a59'),
  ('fn_crash_point_cents(numeric,numeric,numeric)','238188e06a0e12d30117cd6ad877987b'),
  ('fn_choice_prizes(text,text,numeric,integer)','1c3a47e066ae34b57fbe9a034d58f2c4'),
  ('fn_choice_ladder(text)','5842d1342438982415011e690fb666d4'),
  ('fn_choice_board(text,text,bigint,integer)','c450145504a13ca7cd041b4db02cae20'),
  ('fn_choice_start(uuid,text,text,integer,uuid,text,integer)','bd820e09fe4e99a37b3bcd19dc8bd064'),
  ('fn_choice_act(uuid,text,integer,integer)','f1db0b98c0520fe2b0aba82fc1982e52'),
  ('fn_choice_state(uuid,text,text,integer)','9494e5f3ea26dcfee6d735ea2eab031b'),
  ('fn_choice_result(diamond_choice_rounds)','01a237f57ae9e67b1c5de895ef3e8b49'),
  ('fn_choice_immutable()','15ea3891d63ee5a673bcbfc9b0e15250'),
  ('fn_crash_start(uuid,uuid,text,integer,integer)','7023938d49a7b5548f7e263e3c8ed117'),
  ('fn_crash_round_result(crash_rounds)','0fb1a111a420219c4bbcc528ff135e3a'),
  ('fn_crash_decide(crash_rounds,boolean,text,integer)','4e76acd8fb985a3c91922c8425290783'),
  ('fn_crash_cashout(uuid,integer)','36df25374c72a7f0ef4bf2ecf9126c6e'),
  ('fn_wheel_bonus_state(uuid,text,boolean,text,uuid)','40847874ca91e1ff8591186ccf409651'),
  ('fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)','81bf3d433fc050b4b1e07386c2e380c7'),
  ('fn_plinko_table_version(integer)','ae671f7430daa261b3e056f00b46a598'),
  ('fn_diamond_bonus_replay(uuid)','0f8a416e05bb7dda955a9f468bb96e29')
 ) x(signature,body_hash) LOOP
  IF md5(pg_get_functiondef(to_regprocedure('public.'||expected.signature))) IS DISTINCT FROM expected.body_hash THEN
   RAISE EXCEPTION 'Diamond First Step Preimage Changed: %',expected.signature;
  END IF;
 END LOOP;
END $$;

-- 1. The receipt contract is a column now. NULL is a round sealed before today,
--    whose version is still derived from its floor exactly as before.
ALTER TABLE public.diamond_choice_rounds ADD COLUMN payout_version integer CHECK(payout_version>=4);
ALTER TABLE public.crash_rounds ADD COLUMN payout_version integer CHECK(payout_version>=4);

-- 2. THE FLOOR. Half the stake, or for a Super award what the player paid, in
--    whole cents rounded up, never at or above 0.80 of the stake.
CREATE FUNCTION public.fn_diamond_bonus_floor(p_bet numeric, p_boost integer, p_paid_diamonds integer, p_rate integer)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT LEAST(
  CASE WHEN p_boost=2 THEN GREATEST(ceil(p_bet*50)/100, ceil(p_paid_diamonds::numeric*100/p_rate)/100) ELSE ceil(p_bet*50)/100 END,
  (ceil(p_bet*80)-1)/100)
$$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_floor(numeric,integer,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_floor(numeric,integer,integer,integer) TO service_role;

-- What the player paid for a stake: the spin entry plus the add-on when a wheel
-- award funds the base, the whole stake when nothing does.
CREATE FUNCTION public.fn_diamond_game_paid_diamonds(p_stake integer) RETURNS integer
LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE a public.wheel_bonus_awards;
BEGIN a:=public.fn_wheel_starting_award();
 IF a.id IS NULL THEN RETURN p_stake; END IF;
 IF p_stake NOT IN(a.base_diamonds,a.base_diamonds+a.entry_diamonds) THEN RAISE EXCEPTION 'Invalid Award Budget'; END IF;
 RETURN a.entry_diamonds+(p_stake-a.base_diamonds);
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_game_paid_diamonds(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_paid_diamonds(integer) TO service_role;

-- R16: the debit row says what was debited and whether it was the add-on.
CREATE FUNCTION public.fn_diamond_game_debit_text(p_game text, p_stake integer, p_intake boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE a public.wheel_bonus_awards; label text; debit integer;
BEGIN a:=public.fn_wheel_starting_award();
 label:=CASE p_game WHEN 'plinko' THEN 'Diamond Plinko' WHEN 'crash' THEN 'Diamond Crash' WHEN 'mines' THEN 'Diamond Mines' WHEN 'crossing' THEN 'Donkey Cross' ELSE 'Diamond Game' END;
 debit:=public.fn_wheel_bonus_player_debit(p_stake);
 IF a.id IS NULL THEN RETURN format('%s %s (%s Diamonds)',label,CASE WHEN p_intake THEN 'Intake' ELSE 'Bet' END,p_stake); END IF;
 RETURN format('%s Double Diamonds Add-On%s (%s Diamonds Of A %s Diamond Stake)',label,CASE WHEN p_intake THEN ' Intake' ELSE '' END,debit,p_stake);
END $$;
CREATE FUNCTION public.fn_diamond_game_debit_meta(p_stake integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE a public.wheel_bonus_awards;
BEGIN a:=public.fn_wheel_starting_award();
 IF a.id IS NULL THEN RETURN jsonb_build_object('add_on',false,'added_diamonds',0,'stake_diamonds',p_stake,'paid_diamonds',p_stake); END IF;
 RETURN jsonb_build_object('add_on',p_stake>a.base_diamonds,'added_diamonds',p_stake-a.base_diamonds,'stake_diamonds',p_stake,
  'base_diamonds',a.base_diamonds,'entry_diamonds',a.entry_diamonds,'paid_diamonds',a.entry_diamonds+(p_stake-a.base_diamonds),'award_id',a.id);
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_game_debit_text(text,integer,boolean),public.fn_diamond_game_debit_meta(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_debit_text(text,integer,boolean),public.fn_diamond_game_debit_meta(integer) TO service_role;

-- 3. CRASH: the point is never below 1.10x. The identity P(point >= x) =
--    (0.8B - L)/(xB - L) is untouched for every x above the floor.
CREATE OR REPLACE FUNCTION public.fn_crash_point_cents(p_roll numeric, p_bet numeric, p_minimum numeric) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT GREATEST(110,floor(100*(p_minimum+(p_bet*.8-p_minimum)*281474976710656/(p_roll+1))/p_bet))::bigint
$$;

-- 4. THE ROAD AND THE MINES UNDER THE NEW CONTRACT. The old ladder, board and
--    prizes stay readable for rounds sealed before today.
CREATE FUNCTION public.fn_choice_ladder_v4(p_mode text) RETURNS integer[]
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE p_mode WHEN 'road' THEN ARRAY[80,145,185,245,315,410,535,700,910,1180,1540,2000] END
$$;
-- The twenty-four cells other than the first pick, shuffled by Fisher-Yates with
-- rejection sampling on a 32-bit draw whose domain names the first pick.
CREATE FUNCTION public.fn_choice_board_v4(p_server text, p_client text, p_nonce bigint, p_mines integer, p_first integer)
RETURNS integer[] LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public', 'extensions' AS $function$
DECLARE cells integer[]; i integer; j integer; temp integer; cursor integer:=0; v bigint; lim bigint; out integer[];
BEGIN
 IF p_mines NOT IN (5,6,10,15) THEN RAISE EXCEPTION 'Choose A Mine Count'; END IF;
 IF p_first IS NULL OR p_first<0 OR p_first>24 THEN RAISE EXCEPTION 'Choose A First Tile'; END IF;
 cells:=ARRAY(SELECT x FROM generate_series(0,24) x WHERE x<>p_first ORDER BY x);
 FOR i IN REVERSE 24..2 LOOP
  lim:=(4294967296::bigint/i)*i;
  LOOP
   v:=('x'||substr(encode(extensions.hmac(p_client||':'||p_nonce||':board:'||p_first||':'||cursor,p_server,'sha256'),'hex'),1,8))::bit(32)::bigint;
   cursor:=cursor+1; EXIT WHEN v<lim;
  END LOOP;
  j:=(v%i)::integer+1; temp:=cells[i]; cells[i]:=cells[j]; cells[j]:=temp;
 END LOOP;
 SELECT array_agg(x ORDER BY x) INTO out FROM unnest(cells[1:p_mines]) x;
 RETURN out;
END $function$;
-- Prizes carry the floor itself, because the floor now depends on what was paid.
CREATE FUNCTION public.fn_choice_prizes_v4(p_game text, p_mode text, p_bet numeric, p_floor numeric)
RETURNS numeric[] LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $function$
DECLARE out numeric[]:='{}'; ladder integer[]; m integer; k integer;
BEGIN
 IF p_floor IS NULL OR p_floor<0 OR p_floor*5>=p_bet*4 THEN RAISE EXCEPTION 'The Floor Beats The Edge'; END IF;
 IF p_game='crossing' THEN
  ladder:=public.fn_choice_ladder_v4(p_mode);
  IF ladder IS NULL THEN RAISE EXCEPTION 'Choose A Road Difficulty'; END IF;
  FOR k IN 1..cardinality(ladder) LOOP out:=array_append(out,p_bet*ladder[k]/100); END LOOP;
 ELSIF p_game='mines' AND p_mode IN ('5','6','10','15') THEN
  m:=p_mode::integer;
  -- The first pick is safe, so P(survive k) = C(25-m-1,k-1)/C(24,k-1) and the first gem pays 0.80B.
  FOR k IN 1..25-m LOOP out:=array_append(out,p_floor+(p_bet*0.8-p_floor)*public.fn_choice_choose(24,k-1)/public.fn_choice_choose(24-m,k-1)); END LOOP;
 ELSE RAISE EXCEPTION 'Choose A Game Setting'; END IF;
 RETURN out;
END $function$;
REVOKE ALL ON FUNCTION public.fn_choice_ladder_v4(text),public.fn_choice_board_v4(text,text,bigint,integer,integer),public.fn_choice_prizes_v4(text,text,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_ladder_v4(text),public.fn_choice_board_v4(text,text,bigint,integer,integer),public.fn_choice_prizes_v4(text,text,numeric,numeric) TO service_role;

-- The sealed row admits exactly one more write: the mines board, dealt at the
-- first pick, and only the board this row's seed and that pick produce.
CREATE OR REPLACE FUNCTION public.fn_choice_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status='open' THEN
  IF (to_jsonb(NEW)-ARRAY['picked','status','payout_chips','settled_at']) =
     (to_jsonb(OLD)-ARRAY['picked','status','payout_chips','settled_at']) THEN RETURN NEW; END IF;
  IF OLD.game='mines' AND OLD.payout_version>=4 AND OLD.mine_cells='{}' AND OLD.picked='{}' AND cardinality(NEW.picked)=1
   AND NEW.mine_cells=public.fn_choice_board_v4(OLD.server_seed,OLD.client_seed,OLD.nonce,OLD.mode::integer,NEW.picked[1])
   AND (to_jsonb(NEW)-ARRAY['picked','status','payout_chips','settled_at','mine_cells']) =
       (to_jsonb(OLD)-ARRAY['picked','status','payout_chips','settled_at','mine_cells']) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'A Sealed Game Round Cannot Be Rewritten';
END $$;

-- 5. PLINKO: the table follows the floor. The open table with the lowest slot
--    that still carries the floor on this stake, so the multipliers themselves
--    keep the guarantee and the floor never adds expectation beyond cent rounding.
CREATE FUNCTION public.fn_plinko_table_for_floor(p_bet numeric, p_floor numeric) RETURNS integer
LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT t.version FROM public.plinko_tables t
 WHERE t.activated_at IS NOT NULL AND (SELECT min(m) FROM unnest(t.multipliers_cents) m)*p_bet/100>=p_floor
 ORDER BY (SELECT min(m) FROM unnest(t.multipliers_cents) m), t.version LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.fn_plinko_table_for_floor(numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_plinko_table_for_floor(numeric,numeric) TO service_role;

-- The Super Double table: a Super stake with the add-on keeps two thirds of
-- itself, so every slot pays at least 0.72x. Sixteen rows, C(16,k)/65536:
-- 20x on the two outer slots each side (1 drop in 1,928), 10x (1 in 273), 1.7x
-- (1 in 59), then 0.80x, 0.75x, 0.75x, 0.73x and 0.72x across the middle. A
-- two-thirds floor leaves the board no room for more top weight than this:
-- the middle seven slots hold 60,502 of the 65,536 paths and cannot pay under
-- 0.72x, so the ten outer slots share what is left of the 0.80. Exact 0.800000.
INSERT INTO public.plinko_tables(version,name,board_rows,multipliers_cents,max_multiplier_cents,note)
VALUES (6,'Super Double',16,ARRAY[2000,2000,1000,170,80,75,75,73,72,73,75,75,80,170,1000,2000,2000],2000,
 'Super awards with the Double Diamonds add-on. The lowest slot is 0.72x, above the two thirds of the stake that the player paid, so every run returns at least what was paid through the multipliers. Exact 0.800000 return, every slot pays, top 20x.');
DO $$
DECLARE a record; v integer;
BEGIN
 FOREACH v IN ARRAY ARRAY[4,6] LOOP
  SELECT x.* INTO a FROM public.fn_plinko_table_audit(v) x;
  IF a.spec_rtp IS DISTINCT FROM 0.800000 OR a.max_multiplier_cents IS DISTINCT FROM 2000 OR a.hit_rate IS DISTINCT FROM 1.000000 OR a.slots IS DISTINCT FROM 17 THEN
   RAISE EXCEPTION 'Plinko Table % Audit Failed: %',v,to_jsonb(a);
  END IF;
  UPDATE public.plinko_tables SET spec_rtp=a.spec_rtp,sd_chips=a.sd_chips,hit_rate=a.hit_rate,max_multiplier_cents=a.max_multiplier_cents,activated_at=COALESCE(activated_at,now()) WHERE version=v;
 END LOOP;
 -- The Super table now serves every half-floor stake, ordinary awards included.
 UPDATE public.plinko_tables SET note='Every stake whose floor is half of itself: ordinary awards and Super awards without the add-on. The lowest slot is 0.52x, above the half, so every run returns at least its floor through the multipliers. Exact 0.800000 return, every slot pays, top 20x.' WHERE version=4;
 -- Diamond closes: no new stake has a floor a 0.08x slot can carry. Settled batches keep their receipts.
 UPDATE public.plinko_tables SET activated_at=NULL WHERE version=5;
 IF (SELECT array_agg(version ORDER BY version) FROM public.plinko_tables WHERE activated_at IS NOT NULL) IS DISTINCT FROM ARRAY[4,6] THEN
  RAISE EXCEPTION 'Super And Super Double Must Be The Open Plinko Tables';
 END IF;
END $$;

-- 6. Patch the sealed starters, the actor, the deciders, quotes and receipts on
--    their exact preimages.
DO $$
DECLARE original text; needle text; hits integer;
BEGIN
 -- CRASH START: floor from what was paid, point floored at 1.10x, cash out from 1.11x, the add-on named.
 SELECT pg_get_functiondef('public.fn_crash_start(uuid,uuid,text,integer,integer)'::regprocedure) INTO original;
 needle:='public.fn_diamond_bonus_minimum(adm.o_bet_chips,COALESCE((public.fn_wheel_starting_award()).boost_multiplier,1))';
 hits:=(length(original)-length(replace(original,needle,'')))/length(needle);
 IF hits<>2 THEN RAISE EXCEPTION 'Crash minimum call sites: expected 2, found %',hits; END IF;
 original:=replace(original,needle,'public.fn_diamond_bonus_floor(adm.o_bet_chips,COALESCE((public.fn_wheel_starting_award()).boost_multiplier,1),public.fn_diamond_game_paid_diamonds(p_bet_diamonds),adm.o_rate)');
 needle:='  IF v_cap < 101 THEN';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash cap floor missing'; END IF;
 original:=replace(original,needle,'  IF v_cap < 111 THEN');
 needle:='(p_auto_cashout_cents < 101 OR p_auto_cashout_cents > v_cap)';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash auto floor missing'; END IF;
 original:=replace(original,needle,'(p_auto_cashout_cents < 111 OR p_auto_cashout_cents > v_cap)');
 needle:='''Auto Cash Out Must Be Between 1.01x And %s.%sx''';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash auto message missing'; END IF;
 original:=replace(original,needle,'''Auto Cash Out Must Be Between 1.11x And %s.%sx''');
 needle:='format(''Diamond Crash Bet (%s Diamonds)'', p_bet_diamonds),';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash debit label missing'; END IF;
 original:=replace(original,needle,'public.fn_diamond_game_debit_text(''crash'', p_bet_diamonds),');
 needle:='jsonb_build_object(''round_id'', v_id, ''club_id'', p_club_id, ''host_id'', adm.o_host, ''commit_id'', p_commit_id),';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash debit meta missing'; END IF;
 original:=replace(original,needle,'jsonb_build_object(''round_id'', v_id, ''club_id'', p_club_id, ''host_id'', adm.o_host, ''commit_id'', p_commit_id)||public.fn_diamond_game_debit_meta(p_bet_diamonds),');
 needle:='format(''Diamond Crash Intake (%s Diamonds)'', p_bet_diamonds));';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash intake label missing'; END IF;
 original:=replace(original,needle,'public.fn_diamond_game_debit_text(''crash'', p_bet_diamonds, true));');
 needle:='is_fixture, started_at, minimum_payout_chips)';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash insert columns missing'; END IF;
 original:=replace(original,needle,'is_fixture, started_at, minimum_payout_chips, payout_version)');
 needle:='public.fn_diamond_game_paid_diamonds(p_bet_diamonds),adm.o_rate))
  RETURNING * INTO r;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash insert values missing'; END IF;
 original:=replace(original,needle,'public.fn_diamond_game_paid_diamonds(p_bet_diamonds),adm.o_rate), 4)
  RETURNING * INTO r;');
 EXECUTE original;

 -- CRASH DECIDE: the cash-out floor is the round''s own contract.
 SELECT pg_get_functiondef('public.fn_crash_decide(crash_rounds,boolean,text,integer)'::regprocedure) INTO original;
 needle:='  ELSIF p_cashout AND v_now_cents >= 101 THEN';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash decide cash-out floor missing'; END IF;
 original:=replace(original,needle,'  ELSIF p_cashout AND v_now_cents >= (CASE WHEN r.payout_version >= 4 THEN 111 ELSE 101 END) THEN');
 needle:='(p_displayed_cents < 101 OR p_displayed_cents > v_now_cents)';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash decide displayed floor missing'; END IF;
 original:=replace(original,needle,'(p_displayed_cents < (CASE WHEN r.payout_version >= 4 THEN 111 ELSE 101 END) OR p_displayed_cents > v_now_cents)');
 EXECUTE original;

 -- CRASH CASHOUT: the refusal names the round''s floor.
 SELECT pg_get_functiondef('public.fn_crash_cashout(uuid,integer)'::regprocedure) INTO original;
 needle:='  IF r.status <> ''open'' THEN
    RETURN public.fn_crash_round_result(r);
  END IF;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash cashout status check missing'; END IF;
 original:=replace(original,needle,needle||'
  IF r.payout_version >= 4 AND p_multiplier_cents < 111 THEN
    RETURN jsonb_build_object(''ok'',false,''error'',''Cash Out Starts At 1.11x'');
  END IF;');
 EXECUTE original;

 -- CRASH RECEIPT: the sealed version, and the floors the client may cash out at.
 SELECT pg_get_functiondef('public.fn_crash_round_result(crash_rounds)'::regprocedure) INTO original;
 needle:='''payout_version'',CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash payout version missing'; END IF;
 original:=replace(original,needle,'''payout_version'',COALESCE(r.payout_version,CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END),''cashout_floor_cents'',CASE WHEN r.payout_version>=4 THEN 111 ELSE 101 END,''crash_floor_cents'',CASE WHEN r.payout_version>=4 THEN 110 ELSE 100 END,');
 EXECUTE original;

 -- CHOICE START: the floor from what was paid, the v4 ladders, an undealt mines board, the add-on named.
 SELECT pg_get_functiondef('public.fn_choice_start(uuid,text,text,integer,uuid,text,integer)'::regprocedure) INTO original;
 needle:='v_roll bigint:=0; v_cells integer[]:=''{}'';';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice declare block missing'; END IF;
 original:=replace(original,needle,'v_roll bigint:=0; v_cells integer[]:=''{}''; v_floor numeric;');
 needle:='v_prizes:=public.fn_choice_prizes(p_game,p_mode,adm.o_bet_chips,COALESCE((public.fn_wheel_starting_award()).boost_multiplier,1));';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice prize call missing'; END IF;
 original:=replace(original,needle,'v_floor:=public.fn_diamond_bonus_floor(adm.o_bet_chips,COALESCE((public.fn_wheel_starting_award()).boost_multiplier,1),public.fn_diamond_game_paid_diamonds(p_bet),adm.o_rate);
 v_prizes:=public.fn_choice_prizes_v4(p_game,p_mode,adm.o_bet_chips,v_floor);');
 needle:=' IF p_game=''mines'' THEN v_cells:=public.fn_choice_board((adm.o_commit).server_seed,p_client_seed,adm.o_nonce,p_mode::integer);';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice board deal missing'; END IF;
 original:=replace(original,needle,' -- The mines board is dealt at the first pick, from this sealed seed and that pick, so the first tile is always a gem.
 IF p_game=''mines'' THEN v_cells:=''{}'';');
 needle:='''Diamond Game Bet'',''choice:''||v_id,jsonb_build_object(''round_id'',v_id,''game'',p_game,''host_id'',adm.o_host,''club_id'',p_club_id),adm.o_owner,''Diamond Game Intake'');';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice debit label missing'; END IF;
 original:=replace(original,needle,'public.fn_diamond_game_debit_text(p_game,p_bet),''choice:''||v_id,jsonb_build_object(''round_id'',v_id,''game'',p_game,''host_id'',adm.o_host,''club_id'',p_club_id)||public.fn_diamond_game_debit_meta(p_bet),adm.o_owner,public.fn_diamond_game_debit_text(p_game,p_bet,true));');
 needle:='reserved_chips,is_fixture,minimum_payout_chips)';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice insert columns missing'; END IF;
 original:=replace(original,needle,'reserved_chips,is_fixture,minimum_payout_chips,payout_version)');
 needle:='adm.o_fixture,public.fn_diamond_bonus_minimum(adm.o_bet_chips,COALESCE((public.fn_wheel_starting_award()).boost_multiplier,1))) RETURNING * INTO r;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice insert values missing'; END IF;
 original:=replace(original,needle,'adm.o_fixture,v_floor,4) RETURNING * INTO r;');
 EXECUTE original;

 -- CHOICE ACT: an undealt mines board is dealt around the first pick.
 SELECT pg_get_functiondef('public.fn_choice_act(uuid,text,integer,integer)'::regprocedure) INTO original;
 needle:='  IF r.game=''mines'' THEN safe:=NOT(p_cell=ANY(r.mine_cells));';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice act mines test missing'; END IF;
 original:=replace(original,needle,'  IF r.game=''mines'' THEN
   -- A round sealed under contract 4 deals its board here, around the first pick, so that pick is always a gem.
   IF n=0 AND r.payout_version>=4 AND cardinality(r.mine_cells)=0 THEN r.mine_cells:=public.fn_choice_board_v4(r.server_seed,r.client_seed,r.nonce,r.mode::integer,p_cell); END IF;
   safe:=NOT(p_cell=ANY(r.mine_cells));');
 needle:=' UPDATE public.diamond_choice_rounds SET picked=r.picked,status=r.status,payout_chips=v_pay,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice act update missing'; END IF;
 original:=replace(original,needle,' UPDATE public.diamond_choice_rounds SET mine_cells=r.mine_cells,picked=r.picked,status=r.status,payout_chips=v_pay,');
 EXECUTE original;

 -- CHOICE RECEIPT: the sealed version and the first pick the board was dealt around.
 SELECT pg_get_functiondef('public.fn_choice_result(diamond_choice_rounds)'::regprocedure) INTO original;
 needle:='''payout_version'',CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice payout version missing'; END IF;
 original:=replace(original,needle,'''payout_version'',COALESCE(r.payout_version,CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END),');
 needle:='''mine_cells'',to_jsonb(r.mine_cells),''road_roll'',r.road_roll::text) END)';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice proof missing'; END IF;
 original:=replace(original,needle,'''mine_cells'',to_jsonb(r.mine_cells),''road_roll'',r.road_roll::text,''first_pick'',CASE WHEN r.game=''mines'' THEN r.picked[1] END,''payout_version'',COALESCE(r.payout_version,CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END)) END)');
 EXECUTE original;

 -- Quotes without an award: the player pays the whole stake, half of it is the floor.
 SELECT pg_get_functiondef('public.fn_choice_state(uuid,text,text,integer)'::regprocedure) INTO original;
 needle:='prizes:=public.fn_choice_prizes(p_game,public.fn_choice_mode(p_game),p_bet::numeric/rate);';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Choice state quote missing'; END IF;
 EXECUTE replace(original,needle,'prizes:=public.fn_choice_prizes_v4(p_game,public.fn_choice_mode(p_game),p_bet::numeric/rate,public.fn_diamond_bonus_floor(p_bet::numeric/rate,1,p_bet,rate));');

 -- Award quotes say exactly what the start will seal: the floor from what was paid,
 -- the table that carries it, the drop values open to this stake, the crash floors.
 SELECT pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure) INTO original;
 needle:='prizes numeric[];lim integer:=0;k integer;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Bonus state declare block missing'; END IF;
 original:=replace(original,needle,'prizes numeric[];lim integer:=0;k integer;v_paid integer;v_floor numeric;');
 needle:='''plinko_table'',public.fn_plinko_table_version(a.boost_multiplier),
   ''minimum_payout_chips'',public.fn_diamond_bonus_minimum(total::numeric/rate,a.boost_multiplier),''guarantee'',CASE WHEN a.boost_multiplier=2 THEN ''super'' ELSE ''standard'' END);';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Bonus state guarantee block missing'; END IF;
 original:=replace(original,needle,'''plinko_table'',public.fn_plinko_table_for_floor(total::numeric/rate,v_floor),
   ''minimum_payout_chips'',v_floor,''guarantee'',CASE WHEN a.boost_multiplier=2 THEN ''super'' ELSE ''standard'' END,
   ''payout_version'',4,''paid_diamonds'',v_paid,''cashout_floor_cents'',111,''crash_floor_cents'',110,
   ''plinko_denominations'',(SELECT COALESCE(jsonb_agg(DISTINCT d ORDER BY d),''[]''::jsonb) FROM unnest(ARRAY[1,2,4,5,10,20,25,50,100,250,500,total]) d WHERE total%d=0 AND total/d BETWEEN 1 AND 100));');
 needle:='  -- What this award starts with, from the server, so the client can show the guarantee before Start.';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Bonus state guarantee comment missing'; END IF;
 original:=replace(original,needle,'  v_paid:=a.entry_diamonds+(total-a.base_diamonds);
  v_floor:=public.fn_diamond_bonus_floor(total::numeric/rate,a.boost_multiplier,v_paid,rate);'||chr(10)||needle);
 needle:='prizes:=public.fn_choice_prizes(p_game,public.fn_choice_mode(p_game),total::numeric/rate,a.boost_multiplier);';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Bonus state award quote missing'; END IF;
 original:=replace(original,needle,'prizes:=public.fn_choice_prizes_v4(p_game,public.fn_choice_mode(p_game),total::numeric/rate,v_floor);');
 EXECUTE original;

 -- PLINKO: the player''s drop value, the floor on the whole run, the table that carries it, the add-on named.
 SELECT pg_get_functiondef('public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)'::regprocedure) INTO original;
 needle:=' -- Ten drops, always: the drop value is a tenth of the entry, and nobody chooses it.
 -- Admission below keeps entries to whole chips, so a tenth is always whole diamonds.
 IF p_total IS NULL OR p_total%10<>0 OR p_denom IS DISTINCT FROM p_total/10 THEN
  RETURN jsonb_build_object(''ok'',false,''error'',''Plinko Plays Ten Drops. Refresh Before You Play''); END IF;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Plinko ten-drop refusal missing'; END IF;
 original:=replace(original,needle,' -- The drop value is the player''s (Dan, 2026-09-21): a listed value that uses every diamond, one to a hundred drops.
 IF p_total IS NULL OR p_denom IS NULL OR (p_denom NOT IN (1,2,4,5,10,20,25,50,100,250,500) AND p_denom<>p_total) OR p_total%p_denom<>0 OR p_total/p_denom NOT BETWEEN 1 AND 100 THEN
  RETURN jsonb_build_object(''ok'',false,''error'',''Choose A Drop Value That Plays Every Diamond In One To One Hundred Drops''); END IF;');
 needle:=' SELECT * INTO t FROM public.plinko_tables WHERE version=public.fn_plinko_table_version(v_boost) AND activated_at IS NOT NULL;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Plinko table lookup missing'; END IF;
 original:=replace(original,needle,' -- The floor is what the stake kind and the paid diamonds say; the table is the one that carries it.
 v_minimum:=public.fn_diamond_bonus_floor(adm.o_bet_chips,v_boost,public.fn_diamond_game_paid_diamonds(p_total),adm.o_rate);
 SELECT * INTO t FROM public.plinko_tables WHERE version=public.fn_plinko_table_for_floor(adm.o_bet_chips,v_minimum) AND activated_at IS NOT NULL;');
 needle:=' IF v_boost=2 THEN v_minimum:=public.fn_diamond_bonus_minimum(adm.o_bet_chips,2); paid:=GREATEST(paid,v_minimum); END IF;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Plinko floor missing'; END IF;
 original:=replace(original,needle,' -- The floor guards the WHOLE run, never a drop: the table carries it, so this binds only through cent rounding.
 paid:=GREATEST(paid,v_minimum);');
 needle:='''Diamond Spins Plinko Bonus'',''plinko-bonus:''||v_id,
  jsonb_build_object(''bonus_id'',v_id,''club_id'',p_club,''host_id'',adm.o_host,''commit_id'',p_commit),adm.o_owner,''Diamond Spins Plinko Intake'');';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Plinko debit label missing'; END IF;
 original:=replace(original,needle,'public.fn_diamond_game_debit_text(''plinko'',p_total),''plinko-bonus:''||v_id,
  jsonb_build_object(''bonus_id'',v_id,''club_id'',p_club,''host_id'',adm.o_host,''commit_id'',p_commit)||public.fn_diamond_game_debit_meta(p_total),adm.o_owner,public.fn_diamond_game_debit_text(''plinko'',p_total,true));');
 needle:='''minimum_payout_chips'',v_minimum,''payout_version'',CASE WHEN v_boost=2 THEN 3 ELSE 1 END,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Plinko result version missing'; END IF;
 original:=replace(original,needle,'''minimum_payout_chips'',v_minimum,''payout_version'',4,''paid_diamonds'',public.fn_diamond_game_paid_diamonds(p_total),''drop_count'',v_count,');
 EXECUTE original;
END $$;

-- Read back: the design, as installed.
DO $$
DECLARE p numeric[]; b integer[];
BEGIN
 -- R10/R11: the floors, in cents, on the owner''s own example and the smallest stake.
 IF public.fn_diamond_bonus_floor(75,2,5000,100)<>50 OR public.fn_diamond_bonus_floor(50,2,2500,100)<>25
  OR public.fn_diamond_bonus_floor(25,1,2500,100)<>12.5 OR public.fn_diamond_bonus_floor(50,1,5000,100)<>25
  OR public.fn_diamond_bonus_floor(0.25,1,25,100)<>0.13 OR public.fn_diamond_bonus_floor(0.75,2,50,100)<>0.5
  OR public.fn_diamond_bonus_floor(1,1,100,100)<>0.5 THEN RAISE EXCEPTION 'Floor rule not as designed'; END IF;
 -- R3c: the crash point never sits below 1.10x, and above it the identity is untouched.
 IF public.fn_crash_point_cents(281474976710655,1,0.5)<>110 OR public.fn_crash_point_cents(0,1,0.5)<>floor(100*(0.5+0.3*281474976710656)) THEN RAISE EXCEPTION 'Crash floor not as designed'; END IF;
 -- R3b: the first street is 0.80x and certain; the ladder stays monotone to 20x.
 b:=public.fn_choice_ladder_v4('road');
 IF cardinality(b)<>12 OR b[1]<>80 OR b[2]<>145 OR b[12]<>2000 OR (SELECT bool_or(b[i]>=b[i+1]) FROM generate_series(1,11) i) THEN RAISE EXCEPTION 'Road not as designed'; END IF;
 IF (public.fn_choice_ladder('road'))[1]<>110 THEN RAISE EXCEPTION 'Sealed road ladder lost'; END IF;
 -- R3a: nineteen mines prizes on the safe-first-pick closed form, the first gem 0.80B.
 p:=public.fn_choice_prizes_v4('mines','6',1,0.5);
 IF cardinality(p)<>19 OR p[1]<>0.8 OR abs(p[2]-(0.5+0.3*24/18.0))>0.000001 OR abs(p[19]-(0.5+0.3*public.fn_choice_choose(24,18)))>0.000001 THEN RAISE EXCEPTION 'Mines prizes not as designed'; END IF;
 b:=public.fn_choice_board_v4('s','c',1,6,7);
 IF cardinality(b)<>6 OR 7=ANY(b) OR (SELECT count(DISTINCT x) FROM unnest(b) x)<>6 THEN RAISE EXCEPTION 'Mines board not as designed'; END IF;
 IF cardinality(public.fn_choice_board('s','c',1,6))<>6 OR cardinality(public.fn_choice_prizes('mines','6',1))<>19 THEN RAISE EXCEPTION 'Sealed mines contract lost'; END IF;
 -- R6/R10/R11: the tables that carry the floors.
 IF public.fn_plinko_table_for_floor(1,0.5)<>4 OR public.fn_plinko_table_for_floor(0.25,0.13)<>4 OR public.fn_plinko_table_for_floor(75,50)<>6 OR public.fn_plinko_table_for_floor(0.75,0.5)<>6
  OR public.fn_plinko_table_for_floor(1,0.8) IS NOT NULL THEN RAISE EXCEPTION 'Plinko table routing not as designed'; END IF;
 IF (SELECT min(m) FROM public.plinko_tables t, unnest(t.multipliers_cents) m WHERE t.version=6)<>72
  OR (SELECT count(*) FROM public.plinko_tables t, unnest(t.multipliers_cents) m WHERE t.version=6 AND m>=500)<>6
  OR (SELECT spec_rtp FROM public.plinko_tables WHERE version=6)<>0.800000 OR (SELECT activated_at FROM public.plinko_tables WHERE version=5) IS NOT NULL THEN RAISE EXCEPTION 'Plinko tables not as designed'; END IF;
 IF strpos(pg_get_functiondef('public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)'::regprocedure),'(p_denom NOT IN (1,2,4,5,10,20,25,50,100,250,500) AND p_denom<>p_total)')=0
  OR strpos(pg_get_functiondef('public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)'::regprocedure),'Plinko Plays Ten Drops')>0 THEN RAISE EXCEPTION 'Drop values not as designed'; END IF;
 IF strpos(pg_get_functiondef('public.fn_crash_decide(crash_rounds,boolean,text,integer)'::regprocedure),'v_now_cents >= (CASE WHEN r.payout_version >= 4 THEN 111 ELSE 101 END)')=0 THEN RAISE EXCEPTION 'Cash-out floor not as designed'; END IF;
END $$;

COMMIT;
