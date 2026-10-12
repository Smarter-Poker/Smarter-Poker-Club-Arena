-- 20261012114801_crash_never_ends_before_1_25x_averages_2_9x_and_flies_to_20x.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan, 2026-10-12, on Diamond Crash, in order):
--   1. "CRASH ALWAYS CRASHES TOO SOON. THE GAME IS DESIGNED TO GO TO 20X MAX.
--       THE GAME SHOULD NEVER CRASH BEFORE 1.25X AND NEEDS TO LAST A LITTLE
--       LONGER ON AVERAGE."
--   2. "CRASH CAN BE A 5% HOUSE EDGE GAME. MAKE IT BETTER OVERALL FOR THE PLAYERS."
--   3. "BUT CRASH NEEDS TO BE ABLE TO GO AS HIGH AS 20X. MAKE SURE THAT PLAYERS
--       ARE AWARE THAT THE 'AVERAGE CRASH' IS BETWEEN 2.4 -3.0X AND IF THEY 'BOOK
--       THE WIN' OR STOP BEFORE IT CRASHES, IT SHOULD SHOW HOW FAR 'IT WOULD OF
--       GONE'."
--   4. "CRASH CAN GO NEGATIVE, IT CAN PAY OUT UP TO 120% SINCE THE OTHER ARE
--       ALREADY SUPER PROFITABLE."
--
-- CONTRACT 5 (payout_version 5) for every Crash round sealed from now on. It
-- replaces the never-installed draft of contract 5 (PR #6735, a flat 0.95):
-- ruling 4 lets a round return more than its stake, and ruling 3 sets what the
-- player is promised, so the return is now chosen to deliver the average.
--
-- 1. THE POINT. X = max(1.25, L + (R - L) / u), u = (roll + 1) / 2^48, with L
--    the round's loss minimum over its stake exactly as fn_diamond_bonus_floor
--    gives it today (UNCHANGED: half the stake, or for a Super award what the
--    player paid), and R the round's return at every cash-out target. In cents,
--    with B and M the stake and the minimum in chip cents and R in millionths:
--      fn_crash_point_cents_v5 = GREATEST(125, div(100 (10^6 M (r+1) + (R B - 10^6 M) 2^48), 10^6 B (r+1)))
--    Postgres div() on integers, so nothing rounds a quotient up across a
--    hundredth and the browser mirror reproduces it bit for bit.
-- 2. THE RETURN, CHOSEN FOR THE AVERAGE. Capped at 20x, the average crash is
--      E = 1.25 + (R - L) ln((20 - L) / (1.25 - L)),
--    so the R that makes it 2.9x is L + 1.65 / ln((20 - L) / (1.25 - L)),
--    clamped to 0.95 <= R <= 1.20 (ruling 2's floor, ruling 4's ceiling):
--      fn_crash_return_ppm_v5 = LEAST(1200000, GREATEST(950000, floor(10^6 (L + 1.65 / ln(...)))))
--    in millionths, rounded DOWN, computed in numeric at forty decimal places
--    from the round's own sealed stake and minimum, so every round's R is
--    reproducible from what the round already seals and nothing new is stored.
--    A standard round (L = 1/2) gets 1.006430, a Super award with the add-on
--    (L = 2/3) gets 1.137983; both average 2.9x. A floor high enough to need
--    more than 1.20 (only a tiny stake rounds its floor up that far) gets 1.20
--    and a slightly lower average, never a higher return.
--    For any target t above 1.25x, max(raw,125) >= t iff raw >= t, so
--    P(point >= t) = floor(100 (R B - 10^6 M) 2^48 / (10^6 (t B - 100 M))) / 2^48
--    and always cashing at t is worth that share of tB plus the rest at M: at
--    most one roll's grain UNDER R B, never over (proved below for every
--    hundredth from 1.26x to 20.00x, and in the law test).
-- 3. THE FLOOR. Never below 1.25x; cash out, by hand and on auto, opens at
--    1.26x ("Cash Out Starts At 1.26x"), because 1.25x is a certainty.
-- 4. TWENTY TIMES FOR EVERY ROUND. Every Crash config is set to 2,000 cents and
--    the clamp FIXES it there (it was a ceiling of 2,500); fn_crash_start takes
--    LEAST(cap, 2000), and a wheel-funded round whose award cannot cover the
--    full 20x is refused, never shortened. Every award the wheel issues covers
--    it: ordinary awards reserve 40x of their base and Super awards 30x, which is
--    20x of the largest stake either can be played at (base plus one entry).
--    fn_diamond_game_cap_cents is NOT changed: its LEAST already takes the
--    ceiling it is handed (the config's 2,000 for Crash), and it is shared by
--    every game and by the wheel's own admission, which asks it for 4,000 and
--    3,000; a 2,000 inside it would refuse every spin. The un-awarded path
--    (cap_fraction of the pool's headroom) is refused while the wheel's v2
--    release is on, which it is; measured 2026-10-12, no Crash round ever
--    sealed has had a cap below 20x.
-- 5. A LITTLE SLOWER. growth_k 0.10 -> 0.08 on every config and as the clamp's
--    ceiling: 1.25x at 2.8 s, 2x at 8.7 s, 5x at 20.1 s, 20x at 37.4 s.
-- 6. RECEIPTS AND QUOTES. fn_crash_round_result states 126/125 and the round's
--    crash_return_ppm for a contract-5 round; fn_crash_decide and
--    fn_crash_cashout read the round's own version, so every round sealed under
--    contract 4 keeps its 1.10x point, its 1.11x cash-out and its 0.80 return
--    until it settles; fn_wheel_bonus_state quotes payout_version 5, the floors
--    and the return before Start; fn_diamond_game_state says which contract
--    Crash deals. The sealed crash point is still revealed only after
--    settlement (outcome and fairness, unchanged).
--
-- WHAT IT DOES TO THE WHEEL. Every other bonus game still returns 0.80. The
-- wheel's draw, weights, reservations and published table are untouched, so
-- its declared table still sums to 0.80; what changes is what a Crash award is
-- worth when PLAYED. Through the same weights the wheel's long-run payback is
-- 0.825494 of the entry when no add-on is bought (0.827405 at the smallest odd
-- entry, whose floor rounds up to 13/25), and 0.845800 of everything taken in
-- when every Crash award buys the add-on, the house's worst case (worked in
-- integers in tests/the-wheel-never-pays-more-than-it-takes-in.law.test.ts).
-- Below 1.00 either way: the platform still takes in more than the wheel pays.
--
-- RELEASE ORDER. The client that reads this contract must be live BEFORE this
-- is applied.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_return_ppm_v5(numeric,numeric)'::regprocedure))='ee89a197c4eaae7a323e8111ffc5ef8b'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_point_cents_v5(numeric,numeric,numeric)'::regprocedure))='9f0748ecdc32c3bd6c5f5a2037a1c61d'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_start(uuid,uuid,text,integer,integer)'::regprocedure))='6562e95b5a2517f50a54f4e44bf4aabe'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_decide(crash_rounds,boolean,text,integer)'::regprocedure))='a7edd547abe848646bd0584198f06263'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_cashout(uuid,integer)'::regprocedure))='b5c8ee44b4c06fce56ab54ea11c7f739'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_round_result(crash_rounds)'::regprocedure))='2f6f9eff944e0a3d679b52c33169215b'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_config_limits()'::regprocedure))='9a7980051997dcfa02d5e715547a4f7a'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure))='95f04935f26513de5501b943a0ea61de'
-- @live-proof: md5(pg_get_functiondef('public.fn_diamond_game_state(uuid,text)'::regprocedure))='9f9130305c7df2a922e32d280883b11b'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_point_cents(numeric,numeric,numeric)'::regprocedure))='8a093cd8802bf4e2b8790c518b8c2d8e'
-- @live-proof: NOT EXISTS(SELECT 1 FROM public.diamond_game_configs c WHERE c.game='crash' AND (c.max_multiplier_cents<>2000 OR c.growth_k>0.08) AND NOT EXISTS(SELECT 1 FROM public.clubs cl WHERE cl.id=c.host_id AND cl.lifecycle_status='retired'))
-- @live-proof: public.fn_crash_return_ppm_v5(1,0.5)=1006430 AND public.fn_crash_return_ppm_v5(3,2)=1137983 AND public.fn_crash_return_ppm_v5(1,0.79)=1200000
-- @live-proof: NOT has_function_privilege('authenticated','public.fn_crash_point_cents_v5(numeric,numeric,numeric)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_crash_point_cents_v5(numeric,numeric,numeric)','EXECUTE') AND has_function_privilege('service_role','public.fn_crash_point_cents_v5(numeric,numeric,numeric)','EXECUTE')

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

-- The exact bodies this migration replaces or depends on, as read from
-- production on 2026-10-12 (fn_wheel_bonus_state after the Donkey Cross
-- install at 11:38 UTC). Any drift means a sibling change landed first: stop
-- and re-read rather than overwrite somebody else's patch.
DO $preimage$
DECLARE expected record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('fn_crash_start(uuid,uuid,text,integer,integer)','520a695115c3dbab2a105802392adf42'),
  ('fn_crash_decide(crash_rounds,boolean,text,integer)','29391daf7e742c89e5b47ac0d3451e09'),
  ('fn_crash_cashout(uuid,integer)','9d19cb40043de153bae14d69904a9199'),
  ('fn_crash_round_result(crash_rounds)','cce180f8d3c5210ce1b402c8df737652'),
  ('fn_crash_config_limits()','d4636d5a829cfdc6b655e848c1c4e300'),
  ('fn_wheel_bonus_state(uuid,text,boolean,text,uuid)','2c458d77055bad763d2a3255036977af'),
  ('fn_diamond_game_state(uuid,text)','6e1ac8d0e4f1956d5c33479a7790c94c'),
  -- Not replaced. Contract 4's point stays installed so every v4 round keeps recomputing.
  ('fn_crash_point_cents(numeric,numeric,numeric)','8a093cd8802bf4e2b8790c518b8c2d8e'),
  -- Not replaced. The award cap and the bonus floor every round is sealed with.
  ('fn_diamond_game_cap_cents(diamond_game_configs,diamond_game_pools,numeric,numeric,integer)','5f13bfa1f0321604ed2e6849895b6796'),
  ('fn_diamond_bonus_floor(numeric,integer,integer,integer)','f57ba5bc5983e4f45b2e8a6f489786d5')
 ) x(signature,body_hash) LOOP
  IF md5(pg_get_functiondef(to_regprocedure('public.'||expected.signature))) IS DISTINCT FROM expected.body_hash THEN
   RAISE EXCEPTION 'Crash Contract Five Preimage Changed: %',expected.signature;
  END IF;
 END LOOP;
 IF to_regprocedure('public.fn_crash_point_cents_v5(numeric,numeric,numeric)') IS NOT NULL
  OR to_regprocedure('public.fn_crash_return_ppm_v5(numeric,numeric)') IS NOT NULL THEN
  RAISE EXCEPTION 'Crash Contract Five Is Already Installed';
 END IF;
END $preimage$;

-- 1. THE RETURN. Millionths, rounded down, from the round's own stake and minimum.
CREATE FUNCTION public.fn_crash_return_ppm_v5(p_bet numeric, p_minimum numeric) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT LEAST(1200000,GREATEST(950000,floor(
   (1000000*round(p_minimum*100))::numeric(80,40)/round(p_bet*100)
   +1650000::numeric(80,40)/ln(((80*round(p_bet*100)-4*round(p_minimum*100))::numeric(80,40))/(5*round(p_bet*100)-4*round(p_minimum*100)))
 )))::integer
$$;
COMMENT ON FUNCTION public.fn_crash_return_ppm_v5(numeric,numeric) IS
 'Diamond Crash contract 5 (Dan, 2026-10-12): the return R at every cash-out target, in millionths rounded down, chosen so the 20x-capped average crash 1.25 + (R - L) ln((20 - L)/(1.25 - L)) is 2.9x, clamped to 0.95..1.20. L is the round''s minimum over its stake.';
REVOKE ALL ON FUNCTION public.fn_crash_return_ppm_v5(numeric,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_crash_return_ppm_v5(numeric,numeric) TO authenticated,service_role;

-- 2. THE POINT. Integer division, exact: B and M in chip cents, R in millionths.
CREATE FUNCTION public.fn_crash_point_cents_v5(p_roll numeric, p_bet numeric, p_minimum numeric) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT GREATEST(125,div(
   100*(1000000*round(p_minimum*100)*(p_roll+1)+(public.fn_crash_return_ppm_v5(p_bet,p_minimum)*round(p_bet*100)-1000000*round(p_minimum*100))*281474976710656),
   1000000*round(p_bet*100)*(p_roll+1)))::bigint
$$;
COMMENT ON FUNCTION public.fn_crash_point_cents_v5(numeric,numeric,numeric) IS
 'Diamond Crash contract 5 (Dan, 2026-10-12): floor(100 (L + (R - L) 2^48/(roll+1))) cents, never below 125, with R = fn_crash_return_ppm_v5. Every cash-out target from 1.26x returns at most R of the stake.';
REVOKE ALL ON FUNCTION public.fn_crash_point_cents_v5(numeric,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_crash_point_cents_v5(numeric,numeric,numeric) TO service_role;

-- 3. THE CLAMP. Twenty times, fixed, for every Crash config; 0.08 the fastest it may climb.
CREATE OR REPLACE FUNCTION public.fn_crash_config_limits()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
 IF NEW.game='crash' THEN
  -- 20.00x is the cap of every Diamond Crash flight, and every flight can reach
  -- it (Dan, 2026-10-12), so no setting raises or lowers it; and 0.08 is the
  -- fastest it may climb: 20x in about 37 seconds.
  NEW.max_multiplier_cents:=2000;
  NEW.growth_k:=least(NEW.growth_k,0.08);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_crash_config_limits() FROM PUBLIC,anon,authenticated;

-- Every live Crash config takes the new cap and pace now. A retired club's
-- records are read-only and its games cannot be played, so it is left as it is.
UPDATE public.diamond_game_configs c
   SET max_multiplier_cents=2000, growth_k=0.08, updated_at=now()
 WHERE c.game='crash' AND (c.max_multiplier_cents<>2000 OR c.growth_k<>0.08)
   AND NOT EXISTS(SELECT 1 FROM public.clubs cl WHERE cl.id=c.host_id AND cl.lifecycle_status='retired');

-- 4. The starter, the decider, the cash-out, the receipt and the quotes, each on its exact preimage.
DO $patch$
DECLARE original text; needle text; hits integer;
BEGIN
 -- CRASH START: the contract-5 point, the 20x cap, the 1.26x opening, payout_version 5.
 SELECT pg_get_functiondef('public.fn_crash_start(uuid,uuid,text,integer,integer)'::regprocedure) INTO original;
 needle:='  v_cap := public.fn_diamond_game_cap_cents(adm.o_cfg, adm.o_pool, adm.o_bank, adm.o_bet_chips, (adm.o_cfg).max_multiplier_cents);
  IF v_cap < 111 THEN';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash cap block missing'; END IF;
 original:=replace(original,needle,'  -- Contract 5 (Dan, 2026-10-12): twenty times is the cap of every flight.
  v_cap := LEAST(public.fn_diamond_game_cap_cents(adm.o_cfg, adm.o_pool, adm.o_bank, adm.o_bet_chips, (adm.o_cfg).max_multiplier_cents), 2000);
  -- Every wheel-funded flight can reach it: an award that cannot cover 20x is refused, never shortened.
  IF (public.fn_wheel_starting_award()).id IS NOT NULL AND v_cap < 2000 THEN
    RETURN jsonb_build_object(''ok'', false, ''error'', ''This Award Cannot Cover A 20x Flight Right Now. Try Again Shortly'',
                              ''cap_cents'', v_cap);
  END IF;
  IF v_cap < 126 THEN');
 needle:='(p_auto_cashout_cents < 111 OR p_auto_cashout_cents > v_cap)';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash auto floor missing'; END IF;
 original:=replace(original,needle,'(p_auto_cashout_cents < 126 OR p_auto_cashout_cents > v_cap)');
 needle:='''Auto Cash Out Must Be Between 1.11x And %s.%sx''';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash auto message missing'; END IF;
 original:=replace(original,needle,'''Auto Cash Out Must Be Between 1.26x And %s.%sx''');
 needle:='  v_crash := public.fn_crash_point_cents(v_roll,adm.o_bet_chips,';
 hits:=(length(original)-length(replace(original,needle,'')))/length(needle);
 IF hits<>1 THEN RAISE EXCEPTION 'Crash point call sites: expected 1, found %',hits; END IF;
 original:=replace(original,needle,'  v_crash := public.fn_crash_point_cents_v5(v_roll,adm.o_bet_chips,');
 needle:='public.fn_diamond_game_paid_diamonds(p_bet_diamonds),adm.o_rate), 4)
  RETURNING * INTO r;';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash insert version missing'; END IF;
 original:=replace(original,needle,'public.fn_diamond_game_paid_diamonds(p_bet_diamonds),adm.o_rate), 5)
  RETURNING * INTO r;');
 EXECUTE original;

 -- CRASH DECIDE: the cash-out floor is the round's own contract: 1.26x, 1.11x or 1.01x.
 SELECT pg_get_functiondef('public.fn_crash_decide(crash_rounds,boolean,text,integer)'::regprocedure) INTO original;
 needle:='(CASE WHEN r.payout_version >= 4 THEN 111 ELSE 101 END)';
 hits:=(length(original)-length(replace(original,needle,'')))/length(needle);
 IF hits<>2 THEN RAISE EXCEPTION 'Crash decide floors: expected 2, found %',hits; END IF;
 EXECUTE replace(original,needle,'(CASE WHEN r.payout_version >= 5 THEN 126 WHEN r.payout_version >= 4 THEN 111 ELSE 101 END)');

 -- CRASH CASHOUT: the refusal names the round's floor.
 SELECT pg_get_functiondef('public.fn_crash_cashout(uuid,integer)'::regprocedure) INTO original;
 needle:='  IF r.payout_version >= 4 AND p_multiplier_cents < 111 THEN';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash cashout floor missing'; END IF;
 EXECUTE replace(original,needle,'  IF r.payout_version >= 5 AND p_multiplier_cents < 126 THEN
    RETURN jsonb_build_object(''ok'',false,''error'',''Cash Out Starts At 1.26x'');
  END IF;
'||needle);

 -- CRASH RECEIPT: the floors and the return this round's contract plays. The
 -- sealed point is still revealed only once the round is settled.
 SELECT pg_get_functiondef('public.fn_crash_round_result(crash_rounds)'::regprocedure) INTO original;
 needle:='''cashout_floor_cents'',CASE WHEN r.payout_version>=4 THEN 111 ELSE 101 END,''crash_floor_cents'',CASE WHEN r.payout_version>=4 THEN 110 ELSE 100 END,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash receipt floors missing'; END IF;
 EXECUTE replace(original,needle,'''cashout_floor_cents'',CASE WHEN r.payout_version>=5 THEN 126 WHEN r.payout_version>=4 THEN 111 ELSE 101 END,''crash_floor_cents'',CASE WHEN r.payout_version>=5 THEN 125 WHEN r.payout_version>=4 THEN 110 ELSE 100 END,
    ''crash_return_ppm'',CASE WHEN r.payout_version>=5 THEN public.fn_crash_return_ppm_v5(r.bet_chips,r.minimum_payout_chips) ELSE 800000 END,');

 -- AWARD QUOTE: a Crash award says, before Start, the contract the start will seal.
 SELECT pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure) INTO original;
 needle:='''payout_version'',CASE WHEN p_game=''crossing'' THEN 6 WHEN p_game=''mines'' THEN 5 ELSE 4 END,''paid_diamonds'',v_paid,''cashout_floor_cents'',111,''crash_floor_cents'',110,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Bonus quote contract block missing'; END IF;
 EXECUTE replace(original,needle,'''payout_version'',CASE WHEN p_game=''crossing'' THEN 6 WHEN p_game IN(''mines'',''crash'') THEN 5 ELSE 4 END,''paid_diamonds'',v_paid,''cashout_floor_cents'',CASE WHEN p_game=''crash'' THEN 126 ELSE 111 END,''crash_floor_cents'',CASE WHEN p_game=''crash'' THEN 125 ELSE 110 END,
   ''crash_return_ppm'',CASE WHEN p_game=''crash'' THEN public.fn_crash_return_ppm_v5(total::numeric/rate,v_floor) END,');

 -- GAME STATE: which Crash contract new rounds are dealt under, for the lobby's odds.
 SELECT pg_get_functiondef('public.fn_diamond_game_state(uuid,text)'::regprocedure) INTO original;
 needle:='''max_multiplier_cents'', cfg.max_multiplier_cents, ''growth_k'', cfg.growth_k,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Game state config block missing'; END IF;
 EXECUTE replace(original,needle,needle||' ''payout_version'', CASE WHEN p_game = ''crash'' THEN 5 END,');
END $patch$;

-- Read back: the design, as installed. Every figure below is asserted, so a
-- body that does not play the contract aborts the whole transaction.
DO $readback$
DECLARE two48 constant numeric:=281474976710656; t integer; pair numeric[]; b numeric; m numeric; rp numeric; s numeric; v numeric; total numeric; avg numeric;
BEGIN
 -- The returns: standard 1.006430, Super with the add-on 1.137983, a high floor clamped at 1.20, never outside 0.95..1.20.
 IF public.fn_crash_return_ppm_v5(1,0.5)<>1006430 OR public.fn_crash_return_ppm_v5(75,37.5)<>1006430
  OR public.fn_crash_return_ppm_v5(3,2)<>1137983 OR public.fn_crash_return_ppm_v5(75,50)<>1137983
  OR public.fn_crash_return_ppm_v5(1,0.79)<>1200000 OR public.fn_crash_return_ppm_v5(1,0.74)<>1194373
  OR public.fn_crash_return_ppm_v5(0.25,0.13)<>1022420 OR public.fn_crash_return_ppm_v5(1,0)<>950000 THEN
  RAISE EXCEPTION 'Crash return not as designed';
 END IF;
 -- The floor binds at the largest roll; contract 4 is untouched.
 IF public.fn_crash_point_cents_v5(two48-1,1,0.5)<>125 OR public.fn_crash_point_cents_v5(two48-1,75,50)<>125 OR public.fn_crash_point_cents_v5(two48-1,0.25,0.13)<>125 THEN RAISE EXCEPTION 'Crash floor is not 1.25x'; END IF;
 IF public.fn_crash_point_cents(two48-1,1,0.5)<>110 THEN RAISE EXCEPTION 'Contract 4 point changed'; END IF;
 -- Roll 0 is the largest point: L + (R - L) 2^48, exactly.
 IF public.fn_crash_point_cents_v5(0,1,0.5)<>floor(100*(0.5+0.50643*two48)) THEN RAISE EXCEPTION 'Crash top point not as designed'; END IF;
 -- Every target from 1.26x to 20.00x is worth at most R B and within one roll's
 -- grain of it, on the half, the two thirds, the smallest stake and a clamped
 -- floor; and each pair's exact 20x-capped average is what the player is shown.
 FOREACH pair SLICE 1 IN ARRAY ARRAY[[1,0.5],[3,2],[0.25,0.13],[1,0.79]] LOOP
  b:=pair[1]*100; m:=pair[2]*100; rp:=public.fn_crash_return_ppm_v5(pair[1],pair[2]); total:=125*two48;
  FOR t IN 126..2000 LOOP
   s:=div(100*(rp*b-1000000*m)*two48, 1000000*(b*t-100*m));
   IF public.fn_crash_point_cents_v5(s-1,pair[1],pair[2])<t OR public.fn_crash_point_cents_v5(s,pair[1],pair[2])>=t THEN RAISE EXCEPTION 'Crash boundary wrong at % on %',t,pair; END IF;
   v:=1000000*(s*b*t+(two48-s)*100*m);
   IF v>rp*b*100*two48 OR rp*b*100*two48-v>=1000000*(b*t-100*m) THEN RAISE EXCEPTION 'Crash target % is not worth R on %',t,pair; END IF;
   total:=total+s;
  END LOOP;
  avg:=total/two48/100;
  IF (pair[2]/pair[1] BETWEEN 0.5 AND 0.7 AND round(avg,1)<>2.9) OR avg<2.4 OR avg>3.0 THEN RAISE EXCEPTION 'Crash average % on % is not as designed',avg,pair; END IF;
 END LOOP;
 -- Every live config at the new cap and pace.
 IF EXISTS(SELECT 1 FROM public.diamond_game_configs c WHERE c.game='crash' AND (c.max_multiplier_cents<>2000 OR c.growth_k>0.08)
   AND NOT EXISTS(SELECT 1 FROM public.clubs cl WHERE cl.id=c.host_id AND cl.lifecycle_status='retired')) THEN RAISE EXCEPTION 'A crash config is off the 20x cap or the 0.08 pace'; END IF;
 -- The patched bodies say what they should.
 IF strpos(pg_get_functiondef('public.fn_crash_start(uuid,uuid,text,integer,integer)'::regprocedure),'public.fn_crash_point_cents_v5(v_roll')=0
  OR strpos(pg_get_functiondef('public.fn_crash_start(uuid,uuid,text,integer,integer)'::regprocedure),'adm.o_rate), 5)')=0
  OR strpos(pg_get_functiondef('public.fn_crash_decide(crash_rounds,boolean,text,integer)'::regprocedure),'v_now_cents >= (CASE WHEN r.payout_version >= 5 THEN 126 WHEN')=0
  OR strpos(pg_get_functiondef('public.fn_crash_cashout(uuid,integer)'::regprocedure),'Cash Out Starts At 1.26x')=0
  OR strpos(pg_get_functiondef('public.fn_crash_round_result(crash_rounds)'::regprocedure),'fn_crash_return_ppm_v5(r.bet_chips,r.minimum_payout_chips)')=0
  OR strpos(pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure),'IN(''mines'',''crash'') THEN 5')=0
  OR strpos(pg_get_functiondef('public.fn_diamond_game_state(uuid,text)'::regprocedure),'''payout_version'', CASE WHEN p_game = ''crash'' THEN 5 END')=0
  THEN RAISE EXCEPTION 'Crash contract five not as designed'; END IF;
END $readback$;

COMMIT;
