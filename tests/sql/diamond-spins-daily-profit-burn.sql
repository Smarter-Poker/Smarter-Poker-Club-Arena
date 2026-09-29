-- Run only in the private Diamond fixture created by test-accounting-delivery.sh,
-- AFTER migration 20260921202834 (owner ruling 2026-09-21 R14 and the settlement
-- half of R17). Real authoritative functions, every figure asserted exactly,
-- everything rolled back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"service_role"}';
DO $$ BEGIN
  IF current_database() IS DISTINCT FROM 'diamond_games_probe'
     OR NOT EXISTS (SELECT 1 FROM public.ca_financial_epochs WHERE name='Isolated Diamond financial probe' AND is_current)
     OR to_regprocedure('public.fn_diamond_spin_profit_burn_bps()') IS NULL THEN
    RAISE EXCEPTION 'daily profit burn probe requires the isolated fixture with 20260921202834 installed';
  END IF;
END $$;
CREATE FUNCTION pg_temp.diamond_identity() RETURNS numeric LANGUAGE sql AS $$
 SELECT (SELECT COALESCE(sum(diamonds),0) FROM public.profiles)+public.fn_ca_arena_diamonds()
  +COALESCE((SELECT balance FROM public.ca_diamond_house WHERE id=1),0)-public.fn_ca_mint_supply('diamonds');
$$;
CREATE FUNCTION pg_temp.trial(p_since timestamptz,p_account text) RETURNS numeric LANGUAGE sql AS $$
 SELECT difference FROM public.fn_ca_diamond_trial_balance(p_since) WHERE account=p_account;
$$;
CREATE FUNCTION pg_temp.reject_burn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.op_id LIKE 'diamond-spin-burn:%' THEN RAISE EXCEPTION 'Isolated Burn Failure'; END IF;
 RETURN NEW;
END $$;
DO $probe$
DECLARE player uuid:='d1000000-0000-4000-8000-000000000005';owner uuid:='d1000000-0000-4000-8000-000000000002';
 other_operator uuid:='2d1cd6c3-5700-4af9-a271-d4863fdab20d';
 club uuid:='d1000000-0000-4000-8000-000000000003';union_club uuid:='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';union_id uuid:='d1000000-0000-4000-8000-000000000004';
 d date:=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
 initial_identity numeric;initial_owner numeric;supply_before numeric;snapshot_at timestamptz;register_before numeric;
 result jsonb;replay jsonb;statement jsonb;agreement jsonb;denied boolean;receipt uuid;burn_row public.ca_mint_ledger;day_row public.diamond_spin_days;notice public.notifications;
 bps integer:=public.fn_diamond_spin_profit_burn_bps();
BEGIN
 IF bps<>2000 OR public.fn_diamond_spin_profit_burn(210,bps)<>42 OR public.fn_diamond_spin_profit_burn(99,bps)<>19
  OR public.fn_diamond_spin_profit_burn(4,bps)<>0 OR public.fn_diamond_spin_profit_burn(-50,bps)<>0 OR public.fn_diamond_spin_profit_burn(0,bps)<>0
  OR public.fn_diamond_spin_profit_burn(2147483647,bps)<>429496729 THEN RAISE EXCEPTION 'Burn rate or arithmetic wrong'; END IF;
 initial_identity:=pg_temp.diamond_identity();
 SELECT diamonds INTO initial_owner FROM public.profiles WHERE id=owner;
 -- Five closed days, booked through the real custody writer with both hosts:
 --   d-1: 100 union + 200 club entries, 40 throwable, 50 diamond prize = net 210 (burn 42, credit 168)
 --   d-2: 50 throwable                                                  = net -50 (burn 0, debit 50)
 --   d-3: 99 entries                                                    = net 99  (burn 19, credit 80)
 --   d-4: 4 entries                                                     = net 4   (burn 0, credit 4)
 --   d-5: 50 entry, 50 diamond prize                                    = net 0   (burn 0, no wallet row)
 PERFORM public.deduct_diamonds(player,453,'Isolated Burn Entries','test_entry','diamond_game',jsonb_build_object('recipient_id',owner),'burn:player-entries',0);
 PERFORM public.fn_diamond_spin_book(owner,union_club,union_id,'union',player,'entry',100,'burn:d1-union','Isolated Union Entry',d-1);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'entry',200,'burn:d1-club','Isolated Club Entry',d-1);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'throwable',-40,'burn:d1-item','Isolated Throwable Prize',d-1);
 PERFORM public.fn_diamond_spin_book(owner,union_club,union_id,'union',player,'diamond_prize',-50,'burn:d1-prize','Isolated Diamond Prize',d-1);
 PERFORM public.add_diamonds_to_balance(player,50,'transfer','Isolated Diamond Prize','burn:d1-prize-player',owner);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'throwable',-50,'burn:d2-item','Isolated Negative Day',d-2);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'entry',99,'burn:d3-entry','Isolated Odd Entry',d-3);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'entry',4,'burn:d4-entry','Isolated Tiny Entry',d-4);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'entry',50,'burn:d5-entry','Isolated Zero Entry',d-5);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'diamond_prize',-50,'burn:d5-prize','Isolated Zero Prize',d-5);
 PERFORM public.add_diamonds_to_balance(player,50,'transfer','Isolated Zero Prize','burn:d5-prize-player',owner);
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Booking drifted the supply'; END IF;
 IF (SELECT profit_burn_bps+profit_burn FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-1)<>0
  OR (SELECT credited_net FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-1) IS NOT NULL THEN RAISE EXCEPTION 'An open day carries a burn'; END IF;
 -- A burn register failure after the day flips must roll the whole settlement back.
 CREATE TRIGGER isolated_burn_failure BEFORE INSERT ON public.ca_mint_ledger FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_burn();
 denied:=false;
 BEGIN PERFORM public.fn_diamond_spin_settle_day(owner,d-1);
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Isolated Burn Failure' THEN RAISE; END IF;denied:=true; END;
 DROP TRIGGER isolated_burn_failure ON public.ca_mint_ledger;
 IF NOT denied OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner
  OR EXISTS(SELECT 1 FROM public.diamond_transactions WHERE user_id=owner)
  OR (SELECT status FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-1)<>'open'
  OR (SELECT pending_diamonds FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-1)<>210 THEN
  RAISE EXCEPTION 'Burn failure left a partial settlement'; END IF;
 -- Trial balance before: one snapshot, then the register identity as it stands.
 PERFORM public.fn_ca_diamond_snapshot();
 SELECT max(taken_at) INTO snapshot_at FROM public.ca_diamond_snapshots;
 register_before:=pg_temp.trial(snapshot_at,'register');
 supply_before:=public.fn_ca_mint_supply('diamonds');
 -- The profitable day: 20% burned, 80% credited in the one wallet transaction.
 result:=public.fn_diamond_spin_settle_day(owner,d-1);receipt:=(result->>'wallet_transaction_id')::uuid;
 SELECT * INTO day_row FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-1;
 SELECT * INTO burn_row FROM public.ca_mint_ledger WHERE op_id='diamond-spin-burn:'||owner||':'||(d-1);
 SELECT * INTO notice FROM public.notifications WHERE id=day_row.notification_id;
 IF result->>'ok' IS DISTINCT FROM 'true' OR (result->>'net_diamonds')::integer<>210 OR (result->>'profit_burn')::integer<>42
  OR (result->>'credited_net')::integer<>168 OR (result->>'profit_burn_bps')::integer<>2000 OR receipt IS NULL
  OR ROW(day_row.status,day_row.settled_net,day_row.profit_burn_bps,day_row.profit_burn,day_row.credited_net,day_row.pending_diamonds)
     IS DISTINCT FROM ROW('settled'::text,210::bigint,2000,42::bigint,168::bigint,0::bigint)
  OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner+168
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=owner)<>1
  OR NOT EXISTS(SELECT 1 FROM public.diamond_transactions t WHERE t.id=receipt AND t.user_id=owner AND t.amount=168 AND t.transaction_type='transfer'
      AND t.reference_id='diamond-spin-day:'||owner||':'||(d-1) AND t.issuance_class='transferred')
  OR burn_row.id IS NULL OR ROW(burn_row.action,burn_row.asset,burn_row.holder_type,burn_row.holder_id,burn_row.amount,burn_row.balance_before,burn_row.balance_after)
     IS DISTINCT FROM ROW('burn'::text,'diamonds'::text,'player'::text,owner,42::numeric,210::numeric,168::numeric)
  OR burn_row.reason NOT LIKE 'Diamond Spins Daily Profit Burn (20%) For %'
  OR (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id LIKE 'diamond-spin-burn:%')<>1
  OR public.fn_ca_mint_supply('diamonds')<>supply_before-42 THEN
  RAISE EXCEPTION 'Profitable day settlement wrong: % / % / %',result,to_jsonb(day_row),to_jsonb(burn_row); END IF;
 IF notice.id IS NULL OR notice.user_id<>owner OR notice.type<>'diamond_spin_settlement'
  OR (notice.data->>'net_diamonds')::int<>210 OR (notice.data->>'profit_burn')::int<>42 OR (notice.data->>'credited_net')::int<>168
  OR notice.data->>'_push' IS DISTINCT FROM 'ledger_only' OR notice.data->>'burn_op_id' IS DISTINCT FROM burn_row.op_id
  OR notice.message NOT LIKE '210 Diamonds Net For %. Platform Burn (20%): 42. Credited To Your Wallet: 168. Entries: 300. Prizes And Inventory: 90.'
  OR EXISTS(SELECT 1 FROM public.push_outbox WHERE recipient_user_id=owner) THEN
  RAISE EXCEPTION 'Settlement notice wrong or pushed: %',to_jsonb(notice); END IF;
 -- Supply identity and the trial balance both still hold after the burn.
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Burn broke the supply identity'; END IF;
 IF pg_temp.trial(snapshot_at,'player_diamonds')<>0 OR pg_temp.trial(snapshot_at,'register')<>register_before
  OR pg_temp.trial(snapshot_at,'total')<>0 THEN
  RAISE EXCEPTION 'Trial balance moved: player % register % (was %) total %',pg_temp.trial(snapshot_at,'player_diamonds'),
   pg_temp.trial(snapshot_at,'register'),register_before,pg_temp.trial(snapshot_at,'total'); END IF;
 -- Idempotent: the replay returns the same figures and writes nothing.
 replay:=public.fn_diamond_spin_settle_day(owner,d-1);
 IF replay->>'replayed' IS DISTINCT FROM 'true' OR replay->>'wallet_transaction_id'<>receipt::text
  OR (replay->>'profit_burn')::int<>42 OR (replay->>'credited_net')::int<>168 OR (replay->>'net_diamonds')::int<>210
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=owner)<>1
  OR (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id LIKE 'diamond-spin-burn:%')<>1
  OR (SELECT count(*) FROM public.notifications WHERE user_id=owner AND type='diamond_spin_settlement')<>1 THEN
  RAISE EXCEPTION 'Replay settled twice: %',replay; END IF;
 -- Negative day: no burn, the debit is the full shortfall.
 result:=public.fn_diamond_spin_settle_daily(d-2);
 IF (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner+168-50
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=owner AND amount=-50)<>1
  OR (SELECT profit_burn FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-2)<>0
  OR (SELECT credited_net FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-2)<>-50
  OR (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id LIKE 'diamond-spin-burn:%')<>1 THEN RAISE EXCEPTION 'Negative day burned or paid wrong: %',result; END IF;
 -- Rounding: whole diamonds, never above 20%.
 PERFORM public.fn_diamond_spin_settle_day(owner,d-3);
 PERFORM public.fn_diamond_spin_settle_day(owner,d-4);
 IF (SELECT profit_burn FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-3)<>19
  OR (SELECT credited_net FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-3)<>80
  OR (SELECT profit_burn FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-4)<>0
  OR (SELECT credited_net FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-4)<>4
  OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner+168-50+80+4
  OR (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id='diamond-spin-burn:'||owner||':'||(d-3) AND amount=19)<>1
  OR EXISTS(SELECT 1 FROM public.ca_mint_ledger WHERE op_id='diamond-spin-burn:'||owner||':'||(d-4)) THEN RAISE EXCEPTION 'Rounding wrong'; END IF;
 -- Zero day: statement and quiet notice only.
 result:=public.fn_diamond_spin_settle_day(owner,d-5);
 IF (result->>'net_diamonds')::int<>0 OR (result->>'profit_burn')::int<>0 OR result->>'wallet_transaction_id' IS NOT NULL
  OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>initial_owner+202
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=owner)<>4
  OR (SELECT count(*) FROM public.notifications WHERE user_id=owner AND type='diamond_spin_settlement' AND data->>'_push'='ledger_only')<>5
  OR EXISTS(SELECT 1 FROM public.push_outbox WHERE recipient_user_id=owner)
  OR public.fn_ca_mint_supply('diamonds')<>supply_before-61 THEN RAISE EXCEPTION 'Zero day wrong: %',result; END IF;
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Five settlements drifted the supply'; END IF;
 IF pg_temp.trial(snapshot_at,'player_diamonds')<>0 OR pg_temp.trial(snapshot_at,'register')<>register_before OR pg_temp.trial(snapshot_at,'total')<>0 THEN
  RAISE EXCEPTION 'Trial balance moved after five settlements'; END IF;
 -- The owner statement shows the three lines; an open day shows none yet.
 PERFORM public.deduct_diamonds(player,10,'Isolated Open Entry','test_entry','diamond_game',jsonb_build_object('recipient_id',owner),'burn:today-player',0);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'entry',10,'burn:today','Isolated Open Entry',d);
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 PERFORM set_config('test.user',owner::text,true);
 SET LOCAL ROLE authenticated;
 statement:=public.fn_diamond_spin_statements();
 RESET ROLE;
 IF (statement->>'profit_burn_bps')::int<>2000 OR jsonb_array_length(statement->'days')<>6
  OR statement#>>'{days,0,status}'<>'open' OR (statement#>>'{days,0,net_diamonds}')::int<>10
  OR statement#>'{days,0,profit_burn}' IS DISTINCT FROM 'null'::jsonb OR statement#>'{days,0,credited_net}' IS DISTINCT FROM 'null'::jsonb
  OR statement#>'{days,0,profit_burn_bps}' IS DISTINCT FROM 'null'::jsonb
  OR (statement#>>'{days,1,net_diamonds}')::int<>210 OR (statement#>>'{days,1,profit_burn}')::int<>42 OR (statement#>>'{days,1,credited_net}')::int<>168
  OR (statement#>>'{days,1,profit_burn_bps}')::int<>2000 OR jsonb_array_length(statement#>'{days,1,hosts}')<>2
  OR (statement#>>'{days,2,net_diamonds}')::int<>-50 OR (statement#>>'{days,2,profit_burn}')::int<>0 OR (statement#>>'{days,2,credited_net}')::int<>-50
  OR (statement#>>'{days,5,credited_net}')::int<>0 OR statement#>>'{days,5,wallet_transaction_id}' IS NOT NULL THEN
  RAISE EXCEPTION 'Statement lines wrong: %',statement; END IF;
 -- Owner agreement: base receipt keeps the games open, the burn addendum is a
 -- second receipt; a new host records both, a non-owner records nothing.
 SET LOCAL ROLE authenticated;
 agreement:=public.fn_diamond_spins_owner_terms(club,false);
 RESET ROLE;
 IF agreement->>'ok' IS DISTINCT FROM 'true' OR agreement->>'terms_version'<>'diamond-spins-2026-09-14-v1' OR (agreement->>'accepted')::boolean IS NOT TRUE
  OR agreement#>>'{addendum,version}'<>'diamond-spins-2026-09-21-v2' OR (agreement#>>'{addendum,accepted}')::boolean IS NOT FALSE
  OR (agreement#>>'{addendum,profit_burn_bps}')::int<>2000 OR (agreement->>'acknowledged')::boolean IS NOT FALSE
  OR agreement#>>'{addendum,text}' NOT LIKE '%Burns 20%% Of The Net Diamonds%Remaining 80%%%' OR agreement#>>'{addendum,text}' LIKE '%'||chr(8212)||'%' THEN
  RAISE EXCEPTION 'Agreement before acknowledgement wrong: %',agreement; END IF;
 SET LOCAL ROLE authenticated;
 agreement:=public.fn_diamond_spins_owner_terms(club,true);
 RESET ROLE;
 IF (agreement#>>'{addendum,accepted}')::boolean IS NOT TRUE OR (agreement->>'acknowledged')::boolean IS NOT TRUE OR agreement#>>'{addendum,accepted_at}' IS NULL
  OR (SELECT count(*) FROM public.diamond_spins_owner_consents WHERE host_id=club AND owner_id=owner)<>2
  OR (SELECT count(*) FROM public.diamond_spins_owner_consents WHERE host_id=club AND owner_id=owner AND terms_version='diamond-spins-2026-09-14-v1')<>1
  OR NOT public.fn_diamond_spins_owner_agreed(club,'club') THEN RAISE EXCEPTION 'Addendum acknowledgement wrong: %',agreement; END IF;
 SET LOCAL ROLE authenticated;
 agreement:=public.fn_diamond_spins_owner_terms(union_club,true);
 RESET ROLE;
 IF (agreement->>'accepted')::boolean IS NOT TRUE OR (agreement#>>'{addendum,accepted}')::boolean IS NOT TRUE
  OR (SELECT count(*) FROM public.diamond_spins_owner_consents WHERE host_id=union_id AND owner_id=owner)<>2
  OR NOT public.fn_diamond_spins_owner_agreed(union_id,'union') THEN RAISE EXCEPTION 'New host acceptance wrong: %',agreement; END IF;
 PERFORM set_config('test.user',other_operator::text,true);
 SET LOCAL ROLE authenticated;
 agreement:=public.fn_diamond_spins_owner_terms(club,true);
 RESET ROLE;
 IF agreement->>'error' IS DISTINCT FROM 'Only This Host Can Read Its Agreement' AND agreement->>'error' IS DISTINCT FROM 'The Wallet Owner Must Accept This Agreement'
  OR (SELECT count(*) FROM public.diamond_spins_owner_consents WHERE owner_id=other_operator)<>0 THEN RAISE EXCEPTION 'Non-owner acceptance accepted: %',agreement; END IF;
 SET LOCAL ROLE authenticated;
 denied:=false;
 BEGIN PERFORM public.fn_diamond_spin_settle_day(owner,d-1);EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 RESET ROLE;
 IF NOT denied THEN RAISE EXCEPTION 'Private settlement reachable'; END IF;
 -- Settled statements stay permanent, burn figures included.
 denied:=false;
 BEGIN UPDATE public.diamond_spin_days SET profit_burn=0 WHERE owner_id=owner AND day=d-1;
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Diamond Spin Statements And Movements Are Permanent' THEN RAISE; END IF;denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Settled burn rewritten'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Final custody conservation failed'; END IF;
 RAISE NOTICE 'PASS Daily profit burn: 210 net burns 42 and credits 168 in one transfer with one register burn row, negative, odd, tiny and zero days, exact rounding, supply and trial balance unchanged, replay writes nothing, burn failure rolls back, quiet statement notice with no push, three statement lines, base agreement keeps play open and the addendum receipt is separate';
END $probe$;
ROLLBACK;
