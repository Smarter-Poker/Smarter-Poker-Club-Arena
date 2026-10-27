-- Private accounting fixture only. Actual custody, chip payer and settlement.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"service_role"}';
DO $$ BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'private Diamond fixture required'; END IF;
END $$;
-- Date actual payer legs at the chosen closed business day in this disposable
-- fixture, without editing append-only ledger rows or any production record.
CREATE FUNCTION pg_temp.statement_payout_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.created_at:=current_setting('test.statement_time')::timestamptz;RETURN NEW;END $$;
CREATE TRIGGER aa_statement_payout_time BEFORE INSERT ON public.chip_ledger
 FOR EACH ROW EXECUTE FUNCTION pg_temp.statement_payout_time();
DO $probe$
DECLARE owner uuid:='d1000000-0000-4000-8000-000000000002';
 player uuid:='d1000000-0000-4000-8000-000000000005';
 chip_player uuid:='d1000000-0000-4000-8000-000000000001';
 club uuid:='d1000000-0000-4000-8000-000000000003';
 union_club uuid:='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
 host uuid:='d1000000-0000-4000-8000-000000000004';
 -- A fixed closed DST-start day avoids the fixture's current-day paid seeds
 -- and verifies the 23-hour Chicago day rather than assuming 24 hours.
 d date:='2026-03-08';
 category text;pay record;result jsonb;notice public.notifications;old_balance bigint;
 wallet_count bigint;burn_count bigint;notice_count bigint;drain numeric;
BEGIN
 -- 14,850 collected, 50 diamond prizes, 0 inventory, 20% burn, 11,840 credit.
 PERFORM public.deduct_diamonds(player,14850,'Statement Entry','test_entry','diamond_game',jsonb_build_object('recipient_id',owner),'statement:player-entry',0);
 PERFORM public.fn_diamond_spin_book(owner,club,club,'club',player,'entry',14850,'statement:entry','Statement Entry',d);
 PERFORM public.fn_diamond_spin_book(owner,union_club,host,'union',player,'diamond_prize',-50,'statement:diamond','Statement Diamond Prize',d);
 PERFORM public.add_diamonds_to_balance(player,50,'transfer','Statement Diamond Prize','statement:diamond-player',owner);
 PERFORM set_config('test.statement_time',(d::timestamp AT TIME ZONE 'America/Chicago')::text,true);
 -- Canonical category registry, including all four bonus games. One chip each.
 FOREACH category IN ARRAY ARRAY['wheel_prize','plinko_prize','crash_prize','crossing_prize','mines_prize'] LOOP
  SELECT * INTO pay FROM public.fn_diamond_game_pay_chips(category,host,'union',union_club,chip_player,1,
   'statement:'||category,'Statement Prize','{}'::jsonb);
 END LOOP;
 -- Standalone club and real promo/bank split: .25 promo + 2 bank = 2.25.
 PERFORM set_config('test.statement_time',((d-1)::timestamp AT TIME ZONE 'America/Chicago')::text,true);
 SELECT o_promo-.25 INTO drain FROM public.fn_diamond_game_cover_lock(club,'club');
 IF drain<=0 THEN RAISE EXCEPTION 'split fixture has no promo cover'; END IF;
 SELECT * INTO pay FROM public.fn_diamond_game_pay_chips('wheel_prize',club,'club',club,chip_player,drain,
  'statement:prepare-split','Statement Prior Day Prize','{}'::jsonb);
 PERFORM set_config('test.statement_time',(d::timestamp AT TIME ZONE 'America/Chicago')::text,true);
 SELECT * INTO pay FROM public.fn_diamond_game_pay_chips('wheel_prize',club,'club',club,chip_player,2.25,
  'statement:split','Statement Split Prize','{}'::jsonb);
 IF pay.from_promo<>.25 OR pay.from_bank<>2 THEN RAISE EXCEPTION 'split fixture invalid: %',row_to_json(pay); END IF;
 IF public.fn_diamond_spin_chip_payouts(owner,d)<>7.25 THEN RAISE EXCEPTION 'real chip legs wrong'; END IF;
 IF public.fn_diamond_spin_chip_payouts(player,d)<>0 THEN RAISE EXCEPTION 'other owner leaks payouts'; END IF;
 -- Next Chicago midnight is excluded, including a welcome-style payout with
 -- no entry. No multiplication by diamond price and no bonus face valuation.
 PERFORM set_config('test.statement_time',((d+1)::timestamp AT TIME ZONE 'America/Chicago')::text,true);
 SELECT * INTO pay FROM public.fn_diamond_game_pay_chips('wheel_prize',club,'club',club,chip_player,3,
  'statement:next-day','Statement Next Day Prize','{"welcome":true}'::jsonb);
 IF public.fn_diamond_spin_chip_payouts(owner,d)<>7.25
  OR public.fn_diamond_spin_chip_payouts(owner,d+1)<>3 THEN RAISE EXCEPTION 'Chicago boundaries or welcome-only payout wrong: % / %',public.fn_diamond_spin_chip_payouts(owner,d),public.fn_diamond_spin_chip_payouts(owner,d+1); END IF;
 SELECT diamonds INTO old_balance FROM public.profiles WHERE id=owner;
 result:=public.fn_diamond_spin_settle_day(owner,d);
 SELECT * INTO notice FROM public.notifications WHERE id=(result->>'notification_id')::uuid;
 IF notice.message<>format('%s (Chicago). Diamonds Collected: 14,850 Diamonds. Chip Payouts: 7.25 Chips (Paid Separately). Diamond Prizes: 50 Diamonds. Inventory Costs: 0 Diamonds. Net Before Burn: 14,800 Diamonds. Platform Burn (20%%): 2,960 Diamonds. Your Net Credit: 11,840 Diamonds.',d)
  OR notice.data->>'diamonds_collected'<>'14850' OR (notice.data->>'chip_payouts')::numeric<>7.25
  OR notice.data->>'diamond_prizes'<>'50' OR notice.data->>'inventory_cost_diamonds'<>'0'
  OR notice.data->>'credited_net'<>'11840' OR notice.data->>'profit_burn'<>'2960'
  OR notice.data->>'statement_version'<>'2' OR notice.data->>'_push'<>'ledger_only'
  OR notice.message LIKE '%Entries:%' THEN RAISE EXCEPTION 'explicit statement wrong: %',to_jsonb(notice); END IF;
 IF (SELECT diamonds FROM public.profiles WHERE id=owner)<>old_balance+11840
  OR EXISTS(SELECT 1 FROM public.push_outbox WHERE recipient_user_id=owner) THEN RAISE EXCEPTION 'wallet credit or quiet delivery changed'; END IF;
 SELECT count(*) INTO wallet_count FROM public.diamond_transactions;
 SELECT count(*) INTO burn_count FROM public.ca_mint_ledger;
 SELECT count(*) INTO notice_count FROM public.notifications;
 result:=public.fn_diamond_spin_settle_day(owner,d);
 IF result->>'replayed'<>'true' OR (SELECT count(*) FROM public.diamond_transactions)<>wallet_count
  OR (SELECT count(*) FROM public.ca_mint_ledger)<>burn_count OR (SELECT count(*) FROM public.notifications)<>notice_count
  OR (SELECT message FROM public.notifications WHERE id=notice.id)<>notice.message THEN RAISE EXCEPTION 'replay changed money or notification'; END IF;
 IF public.fn_diamond_spin_statement_message(d,0,0,50,0,-50,2000,0,-50) NOT LIKE '%Your Net Debit: 50 Diamonds.'
  OR public.fn_diamond_spin_statement_message(d,0,0,0,0,0,2000,0,0) NOT LIKE '%Your Net Credit: 0 Diamonds.'
  OR public.fn_diamond_spin_statement_message(d,0,NULL,0,0,0,2000,0,0) NOT LIKE '%Chip Payouts: Unavailable%'
  OR public.fn_diamond_spin_statement_message(d,0,0,0,0,0,1250,0,0) NOT LIKE '%Platform Burn (12.5%):%' THEN RAISE EXCEPTION 'negative zero missing or fractional rate wording wrong'; END IF;
 -- A host transfer must not retroactively assign its recorded day to the new
 -- owner; an unallocatable within-day transfer must never read as a partial 0.
 UPDATE public.clubs SET owner_id=player WHERE id=club;
 IF public.fn_diamond_spin_chip_payouts(owner,d)<>7.25 THEN RAISE EXCEPTION 'historical owner replaced'; END IF;
 PERFORM public.fn_diamond_spin_book(player,club,club,'club',chip_player,'entry',25,'statement:new-owner','Statement New Owner',d);
 IF public.fn_diamond_spin_chip_payouts(owner,d) IS NOT NULL THEN RAISE EXCEPTION 'ambiguous ownership guessed'; END IF;
 IF (SELECT data->>'chip_payouts' FROM public.notifications WHERE id=notice.id)<>'7.25' THEN RAISE EXCEPTION 'saved payout snapshot changed'; END IF;
 IF has_function_privilege('anon','public.fn_diamond_spin_chip_payouts(uuid,date)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_diamond_spin_chip_payouts(uuid,date)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_diamond_spin_settle_day(uuid,date)','EXECUTE') THEN RAISE EXCEPTION 'private reporting or writer exposed'; END IF;
 RAISE NOTICE 'PASS Diamond statement units: actual funded five-game payouts, club and union, split funding counted once, Chicago midnight, welcome-only day, owner isolation, exact labels, unchanged 11840 credit and 2960 burn, replay quiet and money unchanged';
END $probe$;
ROLLBACK;
