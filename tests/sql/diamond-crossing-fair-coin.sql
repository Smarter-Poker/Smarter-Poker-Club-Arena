-- Private native PostgreSQL only. Every round below is a real paid Donkey Cross
-- round through the installed doors (admission, debit, reservation, every coin
-- and the payer), and everything rolls back.
--
-- Owner request 2026-10-11: "IT NEEDS TO LITERALLY BE A 50/50 CHANCE TO CROSS
-- THE NEXT STREET ... AND WHEN A USER 'BOOKS THE WIN' IT SHOULD SHOW THEM HOW
-- FAR THEY 'WOULD OF GOTTEN'." Money ruling: "Smaller prizes, keep 80%".
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='600s';
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"role":"authenticated"}';
DO $probe$
DECLARE club uuid:='d1000000-0000-4000-8000-000000000003'; player uuid:='d1000000-0000-4000-8000-000000000005';
 ticket uuid; seed text; quote jsonb; r jsonb; again jsonb; n integer; i integer; k integer; stop integer;
 coins boolean[]; prizes numeric[]; chips numeric; floor_chips numeric; before_chips numeric; expect numeric;
 flips bigint:=0; safes bigint:=0; per_street bigint[]:=array_fill(0::bigint,ARRAY[10]); tries bigint[]:=array_fill(0::bigint,ARRAY[10]);
 cashed integer:=0; lost integer:=0; ran_past integer:=0; first_lost integer:=0; mines jsonb;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,exposure_allowance_chips) SELECT club,'club',g,true,10000 FROM unnest(ARRAY['mines','crossing']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['mines','crossing']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=10000,min_seconds_between_rounds=0 WHERE host_id=club;

 -- THE QUOTE names contract 6 and the coin ladder of this stake's own floor.
 SET LOCAL ROLE authenticated;
 quote:=public.fn_choice_state(club,'crossing','road',100);
 RESET ROLE;
 prizes:=ARRAY(SELECT jsonb_array_elements_text(quote->'prizes')::numeric);
 IF quote->>'payout_version' IS DISTINCT FROM '6' OR prizes IS DISTINCT FROM (public.fn_choice_road_prizes_v6(1,0.5))[1:cardinality(prizes)] OR prizes[1]<>1.1 THEN
  RAISE EXCEPTION 'The quote is not the coin road: %',quote; END IF;
 SET LOCAL ROLE authenticated;
 mines:=public.fn_choice_state(club,'mines','6',100);
 RESET ROLE;
 IF mines->>'payout_version' IS DISTINCT FROM '5' OR ARRAY(SELECT jsonb_array_elements_text(mines->'prizes')::numeric)
   IS DISTINCT FROM (public.fn_choice_prizes_v5('mines','6',100::numeric/100,public.fn_diamond_bonus_floor(100::numeric/100,1,100,100)))[1:(mines->>'max_steps')::integer] THEN RAISE EXCEPTION 'Mines moved off contract 5: %',mines; END IF;

 -- 400 REAL ROUNDS. Each plays to a pre-chosen stop (1..5 streets, then book),
 -- so every street's coin is met on the live path many times.
 FOR i IN 1..400 LOOP
  BEGIN
   ticket:=gen_random_uuid(); seed:=encode(extensions.digest('fair-coin-'||i,'sha256'),'hex');
   INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,'crossing',seed,encode(extensions.digest(seed,'sha256'),'hex'));
   SET LOCAL ROLE authenticated;
   quote:=public.fn_choice_state(club,'crossing','road',2500);
   RESET ROLE;
   SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
   stop:=1+i%5;
   SET LOCAL ROLE authenticated;
   r:=public.fn_choice_start(club,'crossing','road',2500,ticket,'fair-coin-'||i,(quote->>'max_steps')::integer);
   IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'payout_version' IS DISTINCT FROM '6' OR r->'proof' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Contract 6 refused or leaked a coin: %',r; END IF;
   FOR n IN 1..stop LOOP
    EXIT WHEN r->>'status'<>'open';
    r:=public.fn_choice_act((r->>'id')::uuid,'pick',n-1,n-1);
    IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Move refused: %',r; END IF;
    IF r->>'status'='open' AND r->'proof' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'An open road revealed its coins'; END IF;
   END LOOP;
   IF r->>'status'='open' THEN r:=public.fn_choice_act((r->>'id')::uuid,'cashout',NULL,jsonb_array_length(r->'picked')); END IF;
   again:=public.fn_choice_act((r->>'id')::uuid,'cashout',NULL,jsonb_array_length(r->'picked'));
   RESET ROLE;
   n:=jsonb_array_length(r->'picked'); chips:=(r->>'bet_chips')::numeric; floor_chips:=(r->>'minimum_payout_chips')::numeric;
   coins:=public.fn_choice_road_coins_v6(seed,'fair-coin-'||i,(r->>'nonce')::bigint,(r->>'max_steps')::integer);
   -- The receipt reveals exactly the coins this seed flips, and how far they ran.
   IF r#>'{proof,coins}' IS DISTINCT FROM to_jsonb(coins) OR (r#>>'{proof,road_end}')::integer IS DISTINCT FROM public.fn_choice_road_end_v6(coins)
      OR (r#>>'{proof,payout_version}')::integer IS DISTINCT FROM 6 OR again IS DISTINCT FROM r THEN RAISE EXCEPTION 'Receipt does not reveal its coins: %',r; END IF;
   -- Every street played is that street's coin: safe until the last of a lost road.
   FOR k IN 1..n LOOP
    IF coins[k] IS DISTINCT FROM NOT(r->>'status'='lost' AND k=n) THEN RAISE EXCEPTION 'Street % did not follow its coin: %',k,r; END IF;
    tries[k]:=tries[k]+1; IF coins[k] THEN per_street[k]:=per_street[k]+1; END IF;
   END LOOP;
   IF n=1 AND r->>'status'='lost' THEN first_lost:=first_lost+1; END IF;
   -- The payer: a hit keeps max(floor, half the last safe prize); a book pays its street.
   IF r->>'status'='lost' THEN
    expect:=public.fn_choice_loss_floor_v5(ARRAY(SELECT jsonb_array_elements_text(r->'prizes')::numeric),n-1,floor_chips); lost:=lost+1;
   ELSE
    expect:=(r->'prizes'->>(n-1))::numeric; cashed:=cashed+1;
    IF public.fn_choice_road_end_v6(coins)>n THEN ran_past:=ran_past+1; END IF;
   END IF;
   IF abs((r->>'payout_chips')::numeric-expect)>0.01 OR (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips+(r->>'payout_chips')::numeric THEN
    RAISE EXCEPTION 'Round % paid % not % exactly once',i,r->>'payout_chips',expect; END IF;
   RAISE EXCEPTION USING ERRCODE='P0098',MESSAGE='rolled back';
  EXCEPTION WHEN SQLSTATE 'P0098' THEN NULL;
  END;
 END LOOP;
 -- Street one is a coin too, and no street favours either side (4 sigma).
 IF first_lost=0 THEN RAISE EXCEPTION 'Street one never lost: it is not a coin'; END IF;
 FOR k IN 1..3 LOOP
  IF abs(per_street[k]::numeric/tries[k]-0.5)>4*sqrt(0.25/tries[k]) THEN RAISE EXCEPTION 'Street % survived % of % live rounds',k,per_street[k],tries[k]; END IF;
 END LOOP;
 IF cashed=0 OR lost=0 OR ran_past=0 THEN RAISE EXCEPTION 'The live rounds did not cover booking, losing and running past a booked win'; END IF;

 -- 65,536 COINS straight from the installed function: exactly half overall (4 sigma)
 -- and on each of the twenty streets, and a safe street says nothing about the next.
 per_street:=array_fill(0::bigint,ARRAY[20]); safes:=0; flips:=0;
 DECLARE pair bigint:=0; prev_safe bigint:=0; c boolean[];
 BEGIN
  FOR i IN 1..3277 LOOP
   c:=public.fn_choice_road_coins_v6(encode(extensions.digest('coin-space-'||i,'sha256'),'hex'),'player-seed',i,20);
   FOR k IN 1..20 LOOP
    flips:=flips+1; IF c[k] THEN safes:=safes+1; per_street[k]:=per_street[k]+1; END IF;
    IF k>1 AND c[k-1] THEN prev_safe:=prev_safe+1; IF c[k] THEN pair:=pair+1; END IF; END IF;
   END LOOP;
  END LOOP;
  IF abs(safes::numeric/flips-0.5)>4*sqrt(0.25/flips) THEN RAISE EXCEPTION 'Coins were safe % of %',safes,flips; END IF;
  FOR k IN 1..20 LOOP IF abs(per_street[k]::numeric/3277-0.5)>4*sqrt(0.25/3277) THEN RAISE EXCEPTION 'Street % coin was safe % of 3277',k,per_street[k]; END IF; END LOOP;
  IF abs(pair::numeric/prev_safe-0.5)>4*sqrt(0.25/prev_safe) THEN RAISE EXCEPTION 'A safe street predicts the next: % of %',pair,prev_safe; END IF;
  RAISE NOTICE 'coin space: % safe of % flips; after a safe street % of %',safes,flips,pair,prev_safe;
 END;

 -- EVERY STOP IS WORTH AT MOST 0.80 OF THE STAKE, exactly 0.80 below the top,
 -- for every stake 25..7,500 diamonds on every floor a round can carry.
 DECLARE b integer; l numeric; p numeric[]; chance numeric; paid numeric;
 BEGIN
  FOR b IN 25..7500 LOOP
   FOREACH l IN ARRAY ARRAY[ceil(b/2.0)/100,ceil(b*2/3.0)/100,(ceil(b*0.8)-1)/100] LOOP
    CONTINUE WHEN l*5>=b*4/100.0;
    p:=public.fn_choice_road_prizes_v6(b/100.0,l); chance:=1; paid:=0;
    IF p[cardinality(p)]>b/100.0*20 OR cardinality(p)>20 THEN RAISE EXCEPTION 'Stake % floor % ladder exceeds 20x or 20 streets',b,l; END IF;
    FOR k IN 1..cardinality(p) LOOP
     paid:=paid+chance/2*public.fn_choice_loss_floor_v5(p,k-1,l); chance:=chance/2;
     IF paid+chance*p[k]>b/100.0*0.8 OR (p[k]<b/100.0*20 AND paid+chance*p[k]<>b/100.0*0.8) THEN RAISE EXCEPTION 'Stake % floor % stop % is worth %',b,l,k,(paid+chance*p[k])/(b/100.0); END IF;
    END LOOP;
   END LOOP;
  END LOOP;
 END;
 RAISE NOTICE 'PASS Donkey Cross fair coin: contract6 quote and 400 real rounds, every street its own sealed coin, street one a coin, 50/50 per street and independent over 65536 coins, coins and road end revealed on finish, losses keep half the last prize, every stop worth at most 0.80 on every stake and floor, Mines untouched';
END $probe$;
ROLLBACK;
