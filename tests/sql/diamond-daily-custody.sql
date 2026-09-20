-- Real authoritative functions in the private PostgreSQL accounting fixture.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"authenticated"}';
CREATE FUNCTION pg_temp.diamond_identity() RETURNS numeric LANGUAGE sql AS $$
 SELECT (SELECT COALESCE(sum(diamonds),0) FROM public.profiles)+public.fn_ca_arena_diamonds()
  +COALESCE((SELECT balance FROM public.ca_diamond_house WHERE id=1),0)-public.fn_ca_mint_supply('diamonds');
$$;
CREATE FUNCTION pg_temp.spin_for(p_player uuid,p_club uuid,p_target integer,p_mode text DEFAULT 'paid',p_ticket uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE seed text;i integer;nonce bigint;point numeric;commit uuid;outcome jsonb;
 cutoffs integer[]:=ARRAY[10000,15000,29600,39600,44600,59200,69200,71200,85800,95800,98000,100000];low_point integer;
BEGIN
 SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=p_player;
 low_point:=CASE WHEN p_target=1 THEN 0 ELSE cutoffs[p_target-1] END;
 FOR i IN 1..100000 LOOP
  seed:=encode(extensions.digest('custody-'||p_mode||'-'||p_target||'-'||i,'sha256'),'hex');
  point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:custody:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
  EXIT WHEN point>=low_point AND point<cutoffs[p_target];
 END LOOP;
 commit:=gen_random_uuid();
 INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,p_player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
 SET LOCAL ROLE authenticated;
 outcome:=public.fn_wheel_spin_v2(p_club,commit,'custody',100,p_mode,p_ticket);
 RESET ROLE;
 IF outcome->>'ok' IS DISTINCT FROM 'true' OR (outcome#>>'{outcome,ord}')::integer IS DISTINCT FROM p_target THEN
  RAISE EXCEPTION 'Custody spin failed %: %',p_target,outcome; END IF;
 RETURN outcome;
END $$;
CREATE FUNCTION pg_temp.reject_settlement_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.type='diamond_spin_settlement' THEN RAISE EXCEPTION 'Isolated Notification Failure'; END IF;
 RETURN NEW;
END $$;
DO $probe$
DECLARE player uuid:='d1000000-0000-4000-8000-000000000005';owner uuid:='d1000000-0000-4000-8000-000000000002';
 club uuid:='d1000000-0000-4000-8000-000000000003';union_club uuid:='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';union_id uuid:='d1000000-0000-4000-8000-000000000004';
 d date:=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
 initial_identity numeric;initial_owner numeric;initial_player numeric;before_mint numeric;before_custody numeric;before_count bigint;
 result jsonb;replay jsonb;statement jsonb;claimed jsonb;ticket uuid;award uuid;game_commit uuid;game_seed text;denied boolean;target integer;
 old_reference text;receipt uuid;old_pending numeric;before_snapshot jsonb;
BEGIN
 initial_identity:=pg_temp.diamond_identity();
 SELECT diamonds INTO initial_owner FROM public.profiles WHERE id=owner;
 UPDATE public.diamond_wheel_release SET enabled=true;
 UPDATE public.wheel_configs SET exposure_allowance_chips=100000,welcome_budget_chips=10000,min_seconds_between_spins=0 WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips)
 SELECT club,'club',g,true,0,100000 FROM unnest(ARRAY['crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET exposure_allowance_chips=100000,min_seconds_between_rounds=0 WHERE host_id=club;
 -- Real wheel item and diamond prizes, including exact replay. No owner wallet entry.
 FOREACH target IN ARRAY ARRAY[3,5,6,9,1] LOOP
  SELECT diamonds INTO initial_player FROM public.profiles WHERE id=player;
  SELECT COALESCE(sum(pending_diamonds),0) INTO before_custody FROM public.diamond_spin_days WHERE owner_id=owner;
  result:=pg_temp.spin_for(player,club,target);
  IF (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner THEN RAISE EXCEPTION 'Per-spin owner credit remains'; END IF;
  IF (SELECT diamonds FROM public.profiles WHERE id=player)<>initial_player-100+(CASE WHEN target=5 THEN 50 ELSE 0 END) THEN RAISE EXCEPTION 'Wrong player wheel payment'; END IF;
  IF (SELECT sum(pending_diamonds) FROM public.diamond_spin_days WHERE owner_id=owner)<>before_custody+(CASE WHEN target=1 THEN 100 ELSE 50 END) THEN RAISE EXCEPTION 'Wrong wheel custody net'; END IF;
  IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Canonical diamond supply drift after wheel %',target; END IF;
  SELECT count(*) INTO before_count FROM public.diamond_spin_movements;
  SET LOCAL ROLE authenticated;
  replay:=public.fn_wheel_spin_v2(club,(result#>>'{fairness,commit_id}')::uuid,'custody',100,'paid',NULL);
  RESET ROLE;
  IF replay-'replayed' IS DISTINCT FROM result-'replayed' OR (SELECT count(*) FROM public.diamond_spin_movements)<>before_count THEN RAISE EXCEPTION 'Spin replay booked custody again'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.diamond_transactions WHERE user_id=owner) THEN RAISE EXCEPTION 'Per-spin owner journal spam'; END IF;
 -- Real funded Plinko optional Double Down transfers only the added entry.
 award:=(result#>>'{bonus,id}')::uuid;game_commit:=gen_random_uuid();game_seed:=encode(extensions.digest('daily-custody-game','sha256'),'hex');
 INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(game_commit,player,'plinko',game_seed,encode(extensions.digest(game_seed,'sha256'),'hex'));
 SELECT pending_diamonds INTO before_custody FROM public.diamond_spin_days WHERE owner_id=owner AND day=d;
 SET LOCAL ROLE authenticated;
 result:=public.fn_wheel_bonus_start(award,game_commit,'double',true,'steady',100,1,NULL,1);
 RESET ROLE;
 IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Double Down failed: %',result; END IF;
 IF (SELECT pending_diamonds FROM public.diamond_spin_days WHERE owner_id=owner AND day=d)<>before_custody+100
  OR (SELECT bonus_diamonds FROM public.diamond_spin_days WHERE owner_id=owner AND day=d)<>100
  OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner THEN RAISE EXCEPTION 'Wrong Double Down custody'; END IF;
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Double Down supply drift'; END IF;
 -- Claim is required; the Mint funds exactly100 and the player's entry stays free.
 INSERT INTO public.ca_daily_bonus_days(user_id,bonus_date,streak,cycle_day,tiles,first_claimed_at) VALUES(player,d-1,9,2,'[]',now());
 PERFORM public.fn_ca_daily_bonus_status();
 IF EXISTS(SELECT 1 FROM public.diamond_bonus_spin_tickets WHERE user_id=player) THEN RAISE EXCEPTION 'Preview issued ticket'; END IF;
 claimed:=public.fn_ca_daily_bonus_claim(7,gen_random_uuid(),NULL,d);ticket:=(claimed#>>'{granted,ticket_id}')::uuid;
 IF ticket IS NULL THEN RAISE EXCEPTION 'Claim did not issue ticket: %',claimed; END IF;
 SELECT diamonds INTO initial_player FROM public.profiles WHERE id=player;before_mint:=public.fn_ca_mint_supply('diamonds');
 INSERT INTO public.diamond_purchase_lots(user_id,purchase_id,issued) VALUES(player,gen_random_uuid(),500);
 result:=pg_temp.spin_for(player,club,2,'daily',ticket);
 IF EXISTS(SELECT 1 FROM public.diamond_purchase_lots WHERE user_id=player AND consumed<>0) THEN RAISE EXCEPTION 'Free Daily entry consumed purchased diamonds'; END IF;
 IF (SELECT diamonds FROM public.profiles WHERE id=player)<>initial_player OR public.fn_ca_mint_supply('diamonds')<>before_mint+100
  OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner
  OR (SELECT mint_entry_diamonds FROM public.diamond_spin_days WHERE owner_id=owner AND day=d)<>100
  OR (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id='daily-bonus-spin:'||ticket AND amount=100 AND holder_id=player)<>1 THEN
  RAISE EXCEPTION 'Claimed entry was not Mint100 to custody with owner-funded prize'; END IF;
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Mint entry supply drift'; END IF;
 SELECT entry_diamonds+bonus_diamonds+mint_entry_diamonds INTO before_custody FROM public.diamond_spin_days WHERE owner_id=owner AND day=d;
 result:=pg_temp.spin_for(player,club,3,'welcome');
 IF (SELECT entry_diamonds+bonus_diamonds+mint_entry_diamonds FROM public.diamond_spin_days WHERE owner_id=owner AND day=d)<>before_custody THEN RAISE EXCEPTION 'Welcome took entry diamonds'; END IF;
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Welcome supply drift'; END IF;
 -- There is one host owner regardless of which affiliated club the player uses.
 PERFORM public.deduct_diamonds(player,300,'Historical Test Entry','test_entry','diamond_game',jsonb_build_object('recipient_id',owner),'custody:historic-player',0);
 PERFORM public.fn_diamond_spin_book(owner,union_club,union_id,'union',player,'entry',100,'custody:historic-union','Historical Union Entry',d-1);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'entry',200,'custody:historic-club','Historical Club Entry',d-1);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'throwable',-40,'custody:historic-item','Historical Throwable Prize',d-1);
 PERFORM public.fn_diamond_spin_book(owner,union_club,union_id,'union',player,'diamond_prize',-50,'custody:historic-prize','Historical Diamond Prize',d-1);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM public.add_diamonds_to_balance(player,50,'transfer','Historical Diamond Prize','custody:historic-prize-player',owner);
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Historical multi-host supply drift'; END IF;
 denied:=false;
 BEGIN PERFORM public.fn_diamond_spin_book(player,club,club,'club',player,'entry',1,'custody:wrong-owner','Wrong Owner',d-1);
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Diamond Spin Custody Does Not Match The Current Host Owner' THEN RAISE; END IF;denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Wrong owner custody accepted'; END IF;
 -- Backed negative days remain in supply as signed liability and block other spends.
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'throwable',-50,'custody:negative-day','Historical Welcome Expense',d-2);
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Negative custody supply drift'; END IF;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 denied:=false;
 BEGIN PERFORM public.add_diamonds_to_balance(owner,-(initial_owner::integer-49),'transfer','Attempt To Spend Held Diamonds','custody:reserve-spend',player);
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'These Diamonds Back Unsettled Diamond Spin Prizes' THEN RAISE; END IF;denied:=true; END;
 IF NOT denied OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner THEN RAISE EXCEPTION 'Negative backing was spent'; END IF;
 -- Failure after wallet movement must roll the complete settlement back.
 CREATE TRIGGER isolated_settlement_notice_failure BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_settlement_notice();
 denied:=false;
 BEGIN PERFORM public.fn_diamond_spin_settle_day(owner,d-1);
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Isolated Notification Failure' THEN RAISE; END IF;denied:=true; END;
 DROP TRIGGER isolated_settlement_notice_failure ON public.notifications;
 IF NOT denied OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner
  OR EXISTS(SELECT 1 FROM public.diamond_transactions WHERE user_id=owner)
  OR (SELECT status FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-1)<>'open'
  OR (SELECT pending_diamonds FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-1)<>210 THEN
  RAISE EXCEPTION 'Notification failure left a partial settlement'; END IF;
 -- Closed-day settlement consolidates both hosts to one canonical owner credit.
 result:=public.fn_diamond_spin_settle_day(owner,d-1);receipt:=(result->>'wallet_transaction_id')::uuid;
 IF result->>'ok' IS DISTINCT FROM 'true' OR (result->>'net_diamonds')::integer<>210 OR receipt IS NULL
  OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner+210
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=owner)<>1
  OR (SELECT count(*) FROM public.notifications WHERE user_id=owner AND type='diamond_spin_settlement')<>1 THEN RAISE EXCEPTION 'Daily consolidated settlement failed: %',result; END IF;
 replay:=public.fn_diamond_spin_settle_day(owner,d-1);
 IF replay->>'replayed' IS DISTINCT FROM 'true' OR replay->>'wallet_transaction_id'<>receipt::text
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=owner)<>1 THEN RAISE EXCEPTION 'Duplicate daily settlement'; END IF;
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Settlement supply drift'; END IF;
 result:=public.fn_diamond_spin_settle_daily(d-2);
 IF (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner+160 OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=owner)<>2
  OR (SELECT count(*) FROM public.notifications WHERE user_id=owner AND type='diamond_spin_settlement')<>2 THEN RAISE EXCEPTION 'Negative day settlement failed'; END IF;
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Negative settlement supply drift'; END IF;
 denied:=false;
 BEGIN PERFORM public.fn_diamond_spin_settle_day(owner,d);EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Only A Closed Chicago Business Day Can Settle' THEN RAISE; END IF;denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Current day settled early';END IF;
 -- Only the authenticated owner sees its statement, never another member.
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 SET LOCAL ROLE authenticated;
 statement:=public.fn_diamond_spin_statements();
 RESET ROLE;
 IF jsonb_array_length(statement->'days')<>0 THEN RAISE EXCEPTION 'Member read owner statement'; END IF;
 PERFORM set_config('test.user',owner::text,true);
 SET LOCAL ROLE authenticated;
 statement:=public.fn_diamond_spin_statements();
 RESET ROLE;
 IF jsonb_array_length(statement->'days')<>3 OR (statement#>>'{days,1,net_diamonds}')::integer<>210
  OR jsonb_array_length(statement#>'{days,1,hosts}')<>2 OR statement#>>'{days,1,hosts,0,host_name}' IS NULL THEN RAISE EXCEPTION 'Owner statement scope/breakdown wrong: %',statement; END IF;
 SET LOCAL ROLE authenticated;
 statement:=public.fn_diamond_spin_statements(d-1);
 denied:=false;
 BEGIN PERFORM public.fn_diamond_spin_settle_day(owner,d-1);EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 RESET ROLE;
 IF jsonb_array_length(statement->'days')<>1 OR NOT denied THEN RAISE EXCEPTION 'Pagination or private settlement failed'; END IF;
 IF has_table_privilege('authenticated','public.diamond_spin_days','SELECT') OR has_function_privilege('authenticated','public.fn_diamond_spin_book(uuid,uuid,uuid,text,uuid,text,integer,text,text,date)','EXECUTE') THEN RAISE EXCEPTION 'Custody authority public'; END IF;
 denied:=false;
 BEGIN UPDATE public.diamond_spin_days SET settled_net=211 WHERE owner_id=owner AND day=d-1;
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Diamond Spin Statements And Movements Are Permanent' THEN RAISE; END IF;denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Settled statement rewritten'; END IF;
 denied:=false;
 BEGIN UPDATE public.diamond_spin_movements SET description='Changed' WHERE operation_id='custody:historic-club';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Diamond Spin Statements And Movements Are Permanent' THEN RAISE; END IF;denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Custody movement rewritten'; END IF;
 -- Failures roll back all related financial rows in their calling transaction.
 before_snapshot:=jsonb_build_object('days',(SELECT jsonb_agg(to_jsonb(x) ORDER BY owner_id,day) FROM public.diamond_spin_days x),
  'moves',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.diamond_spin_movements x));
 denied:=false;
 BEGIN PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'throwable',-2147483647,'custody:uncovered','Uncovered Test Prize');
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'The Owner Must Fund This Diamond Spin Prize' THEN RAISE; END IF;denied:=true; END;
 IF NOT denied OR before_snapshot IS DISTINCT FROM jsonb_build_object('days',(SELECT jsonb_agg(to_jsonb(x) ORDER BY owner_id,day) FROM public.diamond_spin_days x),
  'moves',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.diamond_spin_movements x)) THEN RAISE EXCEPTION 'Uncovered failure mutated custody'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Final custody conservation failed'; END IF;
 RAISE NOTICE 'PASS Daily Diamond custody: real wheel prizes and Double Down, claimed Mint entry only, welcome, canonical supply, negative backing, owner isolation, one closed-day transfer and notification, replay and atomic rollback';
END $probe$;
ROLLBACK;
