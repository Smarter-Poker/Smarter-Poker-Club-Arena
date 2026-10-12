-- 20261012052305_crash_never_ends_before_1_25x_flies_to_20x_and_pays_back_95_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan, 2026-10-12, on Diamond Crash):
--   "CRASH ALWAYS CRASHES TOO SOON. THE GAME IS DESIGNED TO GO TO 20X MAX. THE
--    GAME SHOULD NEVER CRASH BEFORE 1.25X AND NEEDS TO LAST A LITTLE LONGER ON
--    AVERAGE."
--   "CRASH CAN BE A 5% HOUSE EDGE GAME. MAKE IT BETTER OVERALL FOR THE PLAYERS."
--   "BUT CRASH NEEDS TO BE ABLE TO GO AS HIGH AS 20X."
--
-- CONTRACT 5 (payout_version 5) for every Crash round sealed from now on:
--
-- 1. THE RETURN. Every cash-out target pays back 0.95 of the stake where it
--    paid 0.80. The crash point is X = max(1.25, L + (0.95B - L) / u) with
--    u = (roll + 1) / 2^48 and L the minimum sealed into the round, in cents:
--      fn_crash_point_cents_v5 = GREATEST(125, div(100 (20 L (r+1) + (19 B - 20 L) 2^48), 20 B (r+1)))
--    with B and L in chip cents. That is floor(100 (L + (0.95B - L) 2^48/(r+1)) / B)
--    exactly, computed with Postgres div() on integers so no numeric scale can
--    round a quotient up across a hundredth: the browser mirror reproduces it
--    bit for bit. For any target t above 1.25x, max(raw,125) >= t iff raw >= t,
--    so P(point >= t) = floor((0.95B - L) 2^48 / (tB - L)) / 2^48 and the value
--    of always cashing at t is that share of tB plus the rest at L: at most one
--    roll's grain UNDER 0.95B, never over (proved in the law test for every
--    hundredth from 1.26x to 20.00x, and in tests/sql/diamond-crash-contract-five.sql).
--    The loss minimum is UNCHANGED: fn_diamond_bonus_floor, half the stake, or
--    for a Super award what the player paid.
-- 2. THE FLOOR. The point is never below 1.25x, and cash out (by hand and on
--    auto) opens at 1.26x: booking at the floor itself would be a certain win
--    worth 1.25B, more than the stake, so 1.25x can never be a target.
-- 3. TWENTY TIMES FOR EVERY ROUND. Every Crash config is set to 2,000 cents and
--    the clamp now FIXES it there (it was a ceiling of 2,500), fn_crash_start
--    takes LEAST(cap, 2000), and a wheel-funded round whose award cannot cover
--    the full 20x is refused rather than shortened. Every award the wheel
--    issues covers it: fn_wheel_spin_v2 reserves 40x of an ordinary base and
--    30x of a Super base and refuses the spin otherwise, which is 20x of the
--    largest stake either can be played at (base plus one entry), so
--    fn_diamond_game_cap_cents returns at least 2000 for every award round.
--    fn_diamond_game_cap_cents itself is NOT changed: it is shared by all four
--    games and by the wheel's own admission, which asks it for 4000 and 3000
--    in base units; a 2000 ceiling there would refuse every spin (the defect
--    20261010064303 fixed). The ordinary un-awarded path (only reachable if the
--    wheel's v2 release is switched off) still caps at cap_fraction of the
--    pool's headroom and can be below 20x; that is unchanged and reported.
-- 4. A LITTLE SLOWER. growth_k 0.10 -> 0.08 on every config and as the clamp's
--    ceiling: 1.25x at 2.8 s, 2x at 8.7 s, 5x at 20.1 s, 20x at 37.4 s (was
--    32.2 s to 25x). Pace never moves money: P(point >= t) does not depend on k.
-- 5. RECEIPTS AND QUOTES. fn_crash_round_result states 126/125 for a contract-5
--    round; fn_crash_decide and fn_crash_cashout read the round's own version,
--    so every round sealed under contract 4 keeps its 1.10x point, its 1.11x
--    cash-out and its 0.80 return until it settles; fn_wheel_bonus_state quotes
--    payout_version 5 with the 1.26x and 1.25x floors before Start; and
--    fn_diamond_game_state says which contract Crash deals so the lobby prices
--    the odds of the contract actually in play. The sealed crash point is
--    still revealed only after settlement (outcome and fairness, unchanged).
--
-- WHAT IT DOES TO THE WHEEL. Every other bonus game still returns 0.80. The
-- wheel's draw, its weights, its reservations and its published table are
-- untouched, so its declared table still sums to 0.80; what changes is what a
-- Crash award is WORTH when played: 0.95 of its stake instead of 0.80. Crash is
-- 11.95% of the main wheel and 20% of the Upgrade wheel, so the wheel's real
-- long-run payback rises from 0.800000 to 0.818525 of the entry (exact,
-- through the no-repeat matrix and the cross-tier rule), and the highest
-- expected value after any prize is 0.8765 of the entry. The platform still
-- takes in more than it pays on every spin and on every Crash round.
--
-- RELEASE ORDER. The client that reads contract 5 must be live BEFORE this is
-- applied: the client before it reads payout_version 5 as unknown and refuses
-- the quote and the receipt. That client reads 4 and 5 and prices every figure
-- by the version the server states, so it is correct on either side of this.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_point_cents_v5(numeric,numeric,numeric)'::regprocedure))='66c12bb06a74209bc47ad7a5f1015a1f'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_start(uuid,uuid,text,integer,integer)'::regprocedure))='6562e95b5a2517f50a54f4e44bf4aabe'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_decide(crash_rounds,boolean,text,integer)'::regprocedure))='a7edd547abe848646bd0584198f06263'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_cashout(uuid,integer)'::regprocedure))='b5c8ee44b4c06fce56ab54ea11c7f739'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_round_result(crash_rounds)'::regprocedure))='74771389416909d991215e2ef3e13904'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_config_limits()'::regprocedure))='9a7980051997dcfa02d5e715547a4f7a'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure))='51dec8844d5136ebf9c10bf4776826b1'
-- @live-proof: md5(pg_get_functiondef('public.fn_diamond_game_state(uuid,text)'::regprocedure))='9f9130305c7df2a922e32d280883b11b'
-- @live-proof: md5(pg_get_functiondef('public.fn_crash_point_cents(numeric,numeric,numeric)'::regprocedure))='8a093cd8802bf4e2b8790c518b8c2d8e'
-- @live-proof: NOT EXISTS(SELECT 1 FROM public.diamond_game_configs c WHERE c.game='crash' AND (c.max_multiplier_cents<>2000 OR c.growth_k>0.08) AND NOT EXISTS(SELECT 1 FROM public.clubs cl WHERE cl.id=c.host_id AND cl.lifecycle_status='retired'))
-- @live-proof: NOT has_function_privilege('authenticated','public.fn_crash_point_cents_v5(numeric,numeric,numeric)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_crash_point_cents_v5(numeric,numeric,numeric)','EXECUTE') AND has_function_privilege('service_role','public.fn_crash_point_cents_v5(numeric,numeric,numeric)','EXECUTE')

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

-- The exact bodies this migration replaces or depends on, as read from
-- production on 2026-10-12. Any drift means a sibling change landed first:
-- stop and re-read rather than overwrite somebody else's patch.
DO $preimage$
DECLARE expected record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('fn_crash_start(uuid,uuid,text,integer,integer)','520a695115c3dbab2a105802392adf42'),
  ('fn_crash_decide(crash_rounds,boolean,text,integer)','29391daf7e742c89e5b47ac0d3451e09'),
  ('fn_crash_cashout(uuid,integer)','9d19cb40043de153bae14d69904a9199'),
  ('fn_crash_round_result(crash_rounds)','cce180f8d3c5210ce1b402c8df737652'),
  ('fn_crash_config_limits()','d4636d5a829cfdc6b655e848c1c4e300'),
  ('fn_wheel_bonus_state(uuid,text,boolean,text,uuid)','69d54f1fa2888a25b27b0ac0f914c589'),
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
 IF to_regprocedure('public.fn_crash_point_cents_v5(numeric,numeric,numeric)') IS NOT NULL THEN
  RAISE EXCEPTION 'Crash Contract Five Is Already Installed';
 END IF;
END $preimage$;

-- 1. THE POINT. Integer division, exact: B and L in chip cents.
CREATE FUNCTION public.fn_crash_point_cents_v5(p_roll numeric, p_bet numeric, p_minimum numeric) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT GREATEST(125,div(100*(20*(p_minimum*100)*(p_roll+1)+(19*(p_bet*100)-20*(p_minimum*100))*281474976710656),20*(p_bet*100)*(p_roll+1)))::bigint
$$;
COMMENT ON FUNCTION public.fn_crash_point_cents_v5(numeric,numeric,numeric) IS
 'Diamond Crash contract 5 (Dan, 2026-10-12): floor(100 (L + (0.95B - L) 2^48/(roll+1)) / B) cents, never below 125. Every cash-out target from 1.26x returns at most 0.95 of the stake.';
REVOKE ALL ON FUNCTION public.fn_crash_point_cents_v5(numeric,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_crash_point_cents_v5(numeric,numeric,numeric) TO service_role;

-- 2. THE CLAMP. Twenty times, fixed, for every Crash config; 0.08 the fastest it may climb.
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

-- 3. The starter, the decider, the cash-out, the receipt and the quotes, each on its exact preimage.
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

 -- CRASH RECEIPT: the floors this round's contract plays. The sealed point is
 -- still revealed only once the round is settled (outcome and fairness).
 SELECT pg_get_functiondef('public.fn_crash_round_result(crash_rounds)'::regprocedure) INTO original;
 needle:='''cashout_floor_cents'',CASE WHEN r.payout_version>=4 THEN 111 ELSE 101 END,''crash_floor_cents'',CASE WHEN r.payout_version>=4 THEN 110 ELSE 100 END,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Crash receipt floors missing'; END IF;
 EXECUTE replace(original,needle,'''cashout_floor_cents'',CASE WHEN r.payout_version>=5 THEN 126 WHEN r.payout_version>=4 THEN 111 ELSE 101 END,''crash_floor_cents'',CASE WHEN r.payout_version>=5 THEN 125 WHEN r.payout_version>=4 THEN 110 ELSE 100 END,');

 -- AWARD QUOTE: a Crash award says, before Start, the contract the start will seal.
 SELECT pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure) INTO original;
 needle:='''payout_version'',CASE WHEN p_game IN(''crossing'',''mines'') THEN 5 ELSE 4 END,''paid_diamonds'',v_paid,''cashout_floor_cents'',111,''crash_floor_cents'',110,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Bonus quote contract block missing'; END IF;
 EXECUTE replace(original,needle,'''payout_version'',CASE WHEN p_game IN(''crossing'',''mines'',''crash'') THEN 5 ELSE 4 END,''paid_diamonds'',v_paid,''cashout_floor_cents'',CASE WHEN p_game=''crash'' THEN 126 ELSE 111 END,''crash_floor_cents'',CASE WHEN p_game=''crash'' THEN 125 ELSE 110 END,');

 -- GAME STATE: which Crash contract new rounds are dealt under, for the lobby's odds.
 SELECT pg_get_functiondef('public.fn_diamond_game_state(uuid,text)'::regprocedure) INTO original;
 needle:='''max_multiplier_cents'', cfg.max_multiplier_cents, ''growth_k'', cfg.growth_k,';
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Game state config block missing'; END IF;
 EXECUTE replace(original,needle,needle||' ''payout_version'', CASE WHEN p_game = ''crash'' THEN 5 END,');
END $patch$;

-- Read back: the design, as installed.
DO $readback$
DECLARE two48 constant numeric:=281474976710656; t integer; b numeric; l numeric; s numeric; v numeric;
BEGIN
 -- The floor binds at the largest roll, for every floor kind; contract 4 is untouched.
 IF public.fn_crash_point_cents_v5(two48-1,1,0.5)<>125 OR public.fn_crash_point_cents_v5(two48-1,75,50)<>125 OR public.fn_crash_point_cents_v5(two48-1,0.25,0.13)<>125 THEN RAISE EXCEPTION 'Crash floor is not 1.25x'; END IF;
 IF public.fn_crash_point_cents(two48-1,1,0.5)<>110 THEN RAISE EXCEPTION 'Contract 4 point changed'; END IF;
 -- Roll 0 is the largest point: L + (0.95B - L) 2^48, exactly.
 IF public.fn_crash_point_cents_v5(0,1,0.5)<>floor(100*(0.5+0.45*two48)) THEN RAISE EXCEPTION 'Crash top point not as designed'; END IF;
 -- Every target from 1.26x to 20.00x is worth at most 0.95B and within one roll's grain of it, on the half and the two-thirds floor.
 FOREACH b IN ARRAY ARRAY[1,75] LOOP
  l:=CASE WHEN b=1 THEN 0.5 ELSE 50 END;
  FOR t IN 126..2000 LOOP
   s:=div(5*(19*b*100-20*l*100)*two48, b*100*t-100*l*100);
   IF public.fn_crash_point_cents_v5(s-1,b,l)<t OR public.fn_crash_point_cents_v5(s,b,l)>=t THEN RAISE EXCEPTION 'Crash boundary wrong at % on %',t,b; END IF;
   v:=s*b*100*t+(two48-s)*100*l*100;
   IF v>95*b*100*two48 OR 95*b*100*two48-v>=b*100*t-100*l*100 THEN RAISE EXCEPTION 'Crash target % is not worth 0.95 on %',t,b; END IF;
  END LOOP;
 END LOOP;
 -- Every live config at the new cap and pace.
 IF EXISTS(SELECT 1 FROM public.diamond_game_configs c WHERE c.game='crash' AND (c.max_multiplier_cents<>2000 OR c.growth_k>0.08)
   AND NOT EXISTS(SELECT 1 FROM public.clubs cl WHERE cl.id=c.host_id AND cl.lifecycle_status='retired')) THEN RAISE EXCEPTION 'A crash config is off the 20x cap or the 0.08 pace'; END IF;
 -- The patched bodies say what they should.
 IF strpos(pg_get_functiondef('public.fn_crash_start(uuid,uuid,text,integer,integer)'::regprocedure),'public.fn_crash_point_cents_v5(v_roll')=0
  OR strpos(pg_get_functiondef('public.fn_crash_start(uuid,uuid,text,integer,integer)'::regprocedure),'adm.o_rate), 5)')=0
  OR strpos(pg_get_functiondef('public.fn_crash_decide(crash_rounds,boolean,text,integer)'::regprocedure),'v_now_cents >= (CASE WHEN r.payout_version >= 5 THEN 126 WHEN')=0
  OR strpos(pg_get_functiondef('public.fn_crash_cashout(uuid,integer)'::regprocedure),'Cash Out Starts At 1.26x')=0
  OR strpos(pg_get_functiondef('public.fn_crash_round_result(crash_rounds)'::regprocedure),'THEN 126 WHEN r.payout_version>=4 THEN 111')=0
  OR strpos(pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure),'IN(''crossing'',''mines'',''crash'') THEN 5')=0
  OR strpos(pg_get_functiondef('public.fn_diamond_game_state(uuid,text)'::regprocedure),'''payout_version'', CASE WHEN p_game = ''crash'' THEN 5 END')=0
  THEN RAISE EXCEPTION 'Crash contract five not as designed'; END IF;
END $readback$;

COMMIT;
