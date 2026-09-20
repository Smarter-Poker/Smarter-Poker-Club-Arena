-- Diamond Spins settle one net owner transfer per Chicago business day.
-- Owner instruction September 19: entry diamonds remain in durable custody;
-- diamond prizes and consumed inventory reduce the same daily net. Chip awards
-- continue through the unchanged Promo-first/Main-Bank writer.
-- No historical wallet receipt is moved or rewritten.
BEGIN;
SET LOCAL lock_timeout='3s';

CREATE TABLE public.diamond_spin_days (
 owner_id uuid NOT NULL,
 day date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','settling','settled')),
 pending_diamonds bigint NOT NULL DEFAULT 0,
 entry_diamonds bigint NOT NULL DEFAULT 0 CHECK(entry_diamonds>=0),
 bonus_diamonds bigint NOT NULL DEFAULT 0 CHECK(bonus_diamonds>=0),
 mint_entry_diamonds bigint NOT NULL DEFAULT 0 CHECK(mint_entry_diamonds>=0),
 diamond_prizes bigint NOT NULL DEFAULT 0 CHECK(diamond_prizes>=0),
 throwables bigint NOT NULL DEFAULT 0 CHECK(throwables>=0),
 time_banks bigint NOT NULL DEFAULT 0 CHECK(time_banks>=0),
 rabbit_hunts bigint NOT NULL DEFAULT 0 CHECK(rabbit_hunts>=0),
 other_expenses bigint NOT NULL DEFAULT 0 CHECK(other_expenses>=0),
 movement_count bigint NOT NULL DEFAULT 0 CHECK(movement_count>=0),
 settled_net bigint,
 wallet_transaction_id uuid,
 notification_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 PRIMARY KEY(owner_id,day),
 CHECK(pending_diamonds BETWEEN -2147483647 AND 2147483647),
 CHECK((status='open' AND settled_net IS NULL AND settled_at IS NULL AND wallet_transaction_id IS NULL AND notification_id IS NULL)
  OR (status IN('settling','settled') AND pending_diamonds=0 AND settled_net IS NOT NULL AND settled_at IS NOT NULL AND notification_id IS NOT NULL
      AND (settled_net=0 OR wallet_transaction_id IS NOT NULL))),
 CHECK(CASE WHEN status='open' THEN pending_diamonds ELSE settled_net END
  =entry_diamonds+bonus_diamonds+mint_entry_diamonds-diamond_prizes-throwables-time_banks-rabbit_hunts-other_expenses)
);
CREATE INDEX diamond_spin_days_open ON public.diamond_spin_days(day,owner_id) WHERE status='open';
CREATE TABLE public.diamond_spin_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operation_id text NOT NULL UNIQUE CHECK(length(operation_id) BETWEEN 1 AND 200),
 owner_id uuid NOT NULL,
 day date NOT NULL,
 club_id uuid NOT NULL,
 host_id uuid NOT NULL,
 host_kind text NOT NULL CHECK(host_kind IN('club','union')),
 player_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('entry','bonus','mint_entry','diamond_prize','throwable','time_bank','rabbit_hunt','other_expense')),
 amount integer NOT NULL CHECK(amount<>0),
 description text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind IN('entry','bonus','mint_entry') AND amount>0) OR (kind NOT IN('entry','bonus','mint_entry') AND amount<0)),
 FOREIGN KEY(owner_id,day) REFERENCES public.diamond_spin_days(owner_id,day)
);
CREATE INDEX diamond_spin_movements_day ON public.diamond_spin_movements(owner_id,day,host_id);
ALTER TABLE public.diamond_spin_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diamond_spin_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_spin_days,public.diamond_spin_movements FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_diamond_spin_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR TG_TABLE_NAME='diamond_spin_movements' THEN
  RAISE EXCEPTION 'Diamond Spin Statements And Movements Are Permanent';
 END IF;
 IF OLD.status='settled' THEN
  RAISE EXCEPTION 'Diamond Spin Statements And Movements Are Permanent';
 END IF;
 IF (NEW.owner_id,NEW.day,NEW.created_at) IS DISTINCT FROM (OLD.owner_id,OLD.day,OLD.created_at) THEN
  RAISE EXCEPTION 'Diamond Spin Custody Identity Cannot Change';
 END IF;
 IF (OLD.status='open' AND NEW.status NOT IN('open','settling')) OR (OLD.status='settling' AND NEW.status<>'settled') THEN
  RAISE EXCEPTION 'Invalid Diamond Spin Settlement Transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER diamond_spin_movements_immutable BEFORE UPDATE OR DELETE ON public.diamond_spin_movements
 FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_spin_immutable();
CREATE TRIGGER diamond_spin_days_immutable BEFORE UPDATE OR DELETE ON public.diamond_spin_days
 FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_spin_immutable();

-- The profile row serializes bookings, settlement and every other owner spend.
-- Negative days are fully backed; pending positive days reserve wallet capacity.
CREATE FUNCTION public.fn_diamond_spin_wallet_reserve() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owed numeric;incoming numeric;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.diamond_spin_days WHERE owner_id=OLD.id AND status='open') THEN
   RAISE EXCEPTION 'Settle Diamond Spins Before Removing This Wallet' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 SELECT COALESCE(sum(GREATEST(-pending_diamonds,0)),0),COALESCE(sum(GREATEST(pending_diamonds,0)),0)
  INTO owed,incoming FROM public.diamond_spin_days WHERE owner_id=NEW.id AND status='open';
 IF COALESCE(NEW.diamonds,0)<owed THEN
  RAISE EXCEPTION 'These Diamonds Back Unsettled Diamond Spin Prizes' USING ERRCODE='23514';
 END IF;
 IF COALESCE(NEW.diamonds,0)+incoming>2147483647 THEN
  RAISE EXCEPTION 'This Wallet Must Leave Room For Its Diamond Spin Settlement' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_diamond_spin_wallet_reserve BEFORE UPDATE OF diamonds OR DELETE ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_spin_wallet_reserve();

CREATE FUNCTION public.fn_diamond_spin_available(p_owner uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(p.diamonds,0)
  +COALESCE((SELECT pending_diamonds FROM public.diamond_spin_days WHERE owner_id=p_owner
    AND day=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date AND status='open'),0)
  -COALESCE((SELECT sum(GREATEST(-pending_diamonds,0)) FROM public.diamond_spin_days WHERE owner_id=p_owner
    AND day<>(clock_timestamp() AT TIME ZONE 'America/Chicago')::date AND status='open'),0)
 FROM public.profiles p WHERE p.id=p_owner;
$$;

CREATE FUNCTION public.fn_diamond_spin_book(p_owner uuid,p_club uuid,p_host uuid,p_kind text,p_player uuid,
 p_movement text,p_amount integer,p_operation text,p_description text,p_day date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d date;prior public.diamond_spin_movements;bucket public.diamond_spin_days;
 balance_now numeric;liability numeric;incoming numeric;h record;move_id uuid;v_supply numeric;
BEGIN
 IF p_owner IS NULL OR p_player IS NULL OR p_amount IS NULL OR p_amount=0 OR p_operation IS NULL THEN
  RAISE EXCEPTION 'Invalid Diamond Spin Movement'; END IF;
 SELECT COALESCE(diamonds,0) INTO balance_now FROM public.profiles WHERE id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'The Diamond Spin Owner Wallet Is Missing'; END IF;
 SELECT * INTO prior FROM public.diamond_spin_movements WHERE operation_id=p_operation;
 IF prior.id IS NOT NULL THEN
  IF (prior.owner_id,prior.club_id,prior.host_id,prior.host_kind,prior.player_id,prior.kind,prior.amount,prior.description)
     IS DISTINCT FROM (p_owner,p_club,p_host,p_kind,p_player,p_movement,p_amount,p_description)
     OR (p_day IS NOT NULL AND p_day IS DISTINCT FROM prior.day) THEN
   RAISE EXCEPTION 'That Diamond Spin Movement Does Not Match Its Receipt'; END IF;
  RETURN jsonb_build_object('success',true,'idempotent',true,'movement_id',prior.id,'day',prior.day);
 END IF;
 SELECT * INTO h FROM public.fn_wheel_host(p_club);
 IF h.host_id IS DISTINCT FROM p_host OR h.host_kind IS DISTINCT FROM p_kind
  OR public.fn_diamond_game_owner(p_host,p_kind) IS DISTINCT FROM p_owner THEN
  RAISE EXCEPTION 'Diamond Spin Custody Does Not Match The Current Host Owner'; END IF;
 d:=COALESCE(p_day,(clock_timestamp() AT TIME ZONE 'America/Chicago')::date);
 IF d>(clock_timestamp() AT TIME ZONE 'America/Chicago')::date THEN RAISE EXCEPTION 'Future Diamond Spin Booking Is Invalid'; END IF;
 INSERT INTO public.diamond_spin_days(owner_id,day) VALUES(p_owner,d) ON CONFLICT DO NOTHING;
 SELECT * INTO bucket FROM public.diamond_spin_days WHERE owner_id=p_owner AND day=d FOR UPDATE;
 IF bucket.status<>'open' THEN RAISE EXCEPTION 'That Diamond Spin Day Is Already Settled'; END IF;
 SELECT COALESCE(sum(GREATEST(-pending_diamonds,0)),0),COALESCE(sum(GREATEST(pending_diamonds,0)),0)
  INTO liability,incoming FROM public.diamond_spin_days WHERE owner_id=p_owner AND day<>d AND status='open';
 IF balance_now<liability+GREATEST(-(bucket.pending_diamonds+p_amount),0) THEN
  RAISE EXCEPTION 'The Owner Must Fund This Diamond Spin Prize'; END IF;
 IF balance_now+incoming+GREATEST(bucket.pending_diamonds+p_amount,0)>2147483647 THEN
  RAISE EXCEPTION 'The Diamond Spin Wallet Has Reached Its Settlement Capacity'; END IF;
 INSERT INTO public.diamond_spin_movements(operation_id,owner_id,day,club_id,host_id,host_kind,player_id,kind,amount,description)
 VALUES(p_operation,p_owner,d,p_club,p_host,p_kind,p_player,p_movement,p_amount,p_description) RETURNING id INTO move_id;
 UPDATE public.diamond_spin_days SET pending_diamonds=pending_diamonds+p_amount,movement_count=movement_count+1,
 entry_diamonds=entry_diamonds+CASE WHEN p_movement='entry' THEN p_amount ELSE 0 END,
 bonus_diamonds=bonus_diamonds+CASE WHEN p_movement='bonus' THEN p_amount ELSE 0 END,
 mint_entry_diamonds=mint_entry_diamonds+CASE WHEN p_movement='mint_entry' THEN p_amount ELSE 0 END,
 diamond_prizes=diamond_prizes-CASE WHEN p_movement='diamond_prize' THEN p_amount ELSE 0 END,
 throwables=throwables-CASE WHEN p_movement='throwable' THEN p_amount ELSE 0 END,
 time_banks=time_banks-CASE WHEN p_movement='time_bank' THEN p_amount ELSE 0 END,
 rabbit_hunts=rabbit_hunts-CASE WHEN p_movement='rabbit_hunt' THEN p_amount ELSE 0 END,
 other_expenses=other_expenses-CASE WHEN p_movement='other_expense' THEN p_amount ELSE 0 END
 WHERE owner_id=p_owner AND day=d;
 IF p_movement IN('throwable','time_bank','rabbit_hunt','other_expense') THEN
  -- Actual consumption retires custody diamonds in the same canonical Mint
  -- register used by the existing inventory debit, without an owner wallet spam leg.
  SELECT public.fn_ca_mint_supply('diamonds')+p_amount INTO v_supply;
  INSERT INTO public.ca_mint_ledger(op_id,action,asset,holder_type,holder_id,holder_label,amount,
   balance_before,balance_after,supply_after,reason,performed_by,performed_by_label)
  VALUES('diamond-spin-custody:'||move_id,'burn','diamonds','player',p_owner,
   COALESCE((SELECT username FROM public.profiles WHERE id=p_owner),p_owner::text),-p_amount,
   bucket.pending_diamonds,bucket.pending_diamonds+p_amount,v_supply,'Diamond Spin Inventory: '||p_description,
   auth.uid(),COALESCE((SELECT username FROM public.profiles WHERE id=auth.uid()),auth.uid()::text));
 END IF;
 RETURN jsonb_build_object('success',true,'movement_id',move_id,'day',d,'pending_diamonds',bucket.pending_diamonds+p_amount);
END $$;

CREATE FUNCTION public.fn_diamond_spin_settle_day(p_owner uuid,p_day date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bucket public.diamond_spin_days;paid jsonb;notice uuid:=gen_random_uuid();target_club uuid;
 total numeric;movement_total bigint;v_net integer;v_reference text;
BEGIN
 IF NOT public.fn_is_service_context() THEN RAISE EXCEPTION 'Daily Diamond Settlement Is Service Managed' USING ERRCODE='42501'; END IF;
 IF p_owner IS NULL OR p_day IS NULL OR p_day>=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date THEN
  RAISE EXCEPTION 'Only A Closed Chicago Business Day Can Settle'; END IF;
 PERFORM 1 FROM public.profiles WHERE id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'The Diamond Spin Owner Wallet Is Missing'; END IF;
 SELECT * INTO bucket FROM public.diamond_spin_days WHERE owner_id=p_owner AND day=p_day FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'empty',true,'day',p_day); END IF;
 IF bucket.status='settled' THEN RETURN jsonb_build_object('ok',true,'replayed',true,'day',p_day,'net_diamonds',bucket.settled_net,'wallet_transaction_id',bucket.wallet_transaction_id,'notification_id',bucket.notification_id); END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'Diamond Settlement Is Paused For Maintenance'; END IF;
 SELECT COALESCE(sum(amount),0),count(*) INTO total,movement_total FROM public.diamond_spin_movements WHERE owner_id=p_owner AND day=p_day;
 IF total IS DISTINCT FROM bucket.pending_diamonds OR movement_total IS DISTINCT FROM bucket.movement_count THEN
  RAISE EXCEPTION 'Diamond Spin Statement Does Not Match Its Movements'; END IF;
 v_net:=bucket.pending_diamonds::integer;
 v_reference:='diamond-spin-day:'||p_owner||':'||p_day;
 -- Release exactly this day's balance before the canonical wallet writer checks
 -- other days' reserves. All state, wallet, statement and notification commit together.
 -- A placeholder transaction ID is replaced below in the same transaction; no
 -- externally visible half-settlement is possible.
 UPDATE public.diamond_spin_days SET status='settling',pending_diamonds=0,settled_net=v_net,
  settled_at=clock_timestamp(),wallet_transaction_id=CASE WHEN v_net<>0 THEN notice END,notification_id=notice
  WHERE owner_id=p_owner AND day=p_day;
 IF v_net<>0 THEN
  paid:=public.add_diamonds_to_balance(p_owner,v_net,'transfer',
    'Diamond Spins Daily Net Settlement For '||p_day,v_reference,p_owner);
  IF COALESCE((paid->>'success')::boolean,false) IS NOT TRUE THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Failed: %',COALESCE(paid->>'error','unknown'); END IF;
 END IF;
 SELECT club_id INTO target_club FROM public.diamond_spin_movements WHERE owner_id=p_owner AND day=p_day ORDER BY created_at,id LIMIT 1;
 INSERT INTO public.notifications(id,user_id,type,title,message,data,action_url,link)
 VALUES(notice,p_owner,'diamond_spin_settlement','Diamond Spins Daily Statement',
  format('%s Diamonds Net For %s. Entries: %s. Prizes And Inventory: %s.',v_net,p_day,
   bucket.entry_diamonds+bucket.bonus_diamonds+bucket.mint_entry_diamonds,
   bucket.diamond_prizes+bucket.throwables+bucket.time_banks+bucket.rabbit_hunts+bucket.other_expenses),
  jsonb_build_object('day',p_day,'timezone','America/Chicago','net_diamonds',v_net,'club_id',target_club,'wallet_transaction_id',paid->>'transaction_id'),
  '/hub/club-arena/clubs/'||target_club||'/diamond-games-operations',
  '/hub/club-arena/clubs/'||target_club||'/diamond-games-operations');
 -- The legal open-to-settled transition is performed once by the actual writer;
 -- finalized receipts are never updated afterward (trigger recognizes this local phase).
 UPDATE public.diamond_spin_days SET status='settled',wallet_transaction_id=(paid->>'transaction_id')::uuid
 WHERE owner_id=p_owner AND day=p_day;
 RETURN jsonb_build_object('ok',true,'day',p_day,'net_diamonds',v_net,'wallet_transaction_id',paid->>'transaction_id','notification_id',notice);
END $$;

-- A deferred check prevents an intermediate settlement or unbacked receipt
-- from becoming durable, including privileged accidental partial writes.
CREATE FUNCTION public.fn_diamond_spin_settlement_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.diamond_spin_days;
BEGIN
 SELECT * INTO d FROM public.diamond_spin_days WHERE owner_id=NEW.owner_id AND day=NEW.day;
 IF d.status='settling' THEN RAISE EXCEPTION 'Diamond Spin Settlement Is Incomplete'; END IF;
 IF d.status='settled' THEN
  IF d.settled_net<>0 AND NOT EXISTS(SELECT 1 FROM public.diamond_transactions t
   WHERE t.id=d.wallet_transaction_id AND t.user_id=d.owner_id AND t.amount=d.settled_net
    AND t.reference_id='diamond-spin-day:'||d.owner_id||':'||d.day AND t.issuance_class='transferred') THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Has No Matching Wallet Receipt'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.id=d.notification_id AND n.user_id=d.owner_id
   AND n.type='diamond_spin_settlement' AND n.data->>'day'=d.day::text
   AND (n.data->>'net_diamonds')::bigint=d.settled_net) THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Has No Matching Notification'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER diamond_spin_settlement_receipt AFTER INSERT OR UPDATE ON public.diamond_spin_days
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_spin_settlement_receipt();

CREATE FUNCTION public.fn_diamond_spin_statements(p_before_day date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid();days jsonb;last_day date;n integer;
BEGIN
 IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To View Diamond Statements'); END IF;
 WITH selected AS (SELECT * FROM public.diamond_spin_days WHERE owner_id=v_user AND (p_before_day IS NULL OR day<p_before_day) ORDER BY day DESC LIMIT 31),
 rows AS (SELECT s.day,jsonb_build_object('day',s.day,'status',s.status,'entry_diamonds',s.entry_diamonds,
 'bonus_diamonds',s.bonus_diamonds,'mint_entry_diamonds',s.mint_entry_diamonds,'diamond_prizes',s.diamond_prizes,
 'throwables',s.throwables,'time_banks',s.time_banks,'rabbit_hunts',s.rabbit_hunts,'other_expenses',s.other_expenses,
 'net_diamonds',CASE WHEN s.status='open' THEN s.pending_diamonds ELSE s.settled_net END,
 'settled_at',s.settled_at,'wallet_transaction_id',s.wallet_transaction_id,
 'hosts',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.host_kind,t.host_id) FROM
  (SELECT host_id,host_kind,CASE WHEN host_kind='union' THEN (SELECT name FROM public.unions WHERE id=host_id)
     ELSE (SELECT name FROM public.clubs WHERE id=host_id) END host_name,array_agg(DISTINCT club_id) club_ids,
    sum(GREATEST(amount,0)) entries,sum(GREATEST(-amount,0)) expenses,sum(amount) net_diamonds
   FROM public.diamond_spin_movements WHERE owner_id=v_user AND day=s.day GROUP BY host_id,host_kind) t),'[]'::jsonb)) item FROM selected s)
 SELECT COALESCE(jsonb_agg(item ORDER BY day DESC),'[]'::jsonb),min(day),count(*) INTO days,last_day,n FROM rows;
 RETURN jsonb_build_object('ok',true,'timezone','America/Chicago','days',days,'next_before_day',CASE WHEN n=31 THEN last_day END);
END $$;

DO $patch$
DECLARE original text;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_arena_diamonds()'::regprocedure) INTO original;
 IF md5(original)<>'2dc836d3ae2a15e87f85ef35d88de1a5' THEN RAISE EXCEPTION 'Diamond custody preimage changed: fn_ca_arena_diamonds'; END IF;
 original:=replace(original,$old$SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody;$old$,$new$SELECT (SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody)
   +(SELECT COALESCE(sum(pending_diamonds),0)::numeric FROM public.diamond_spin_days WHERE status='open');$new$);
 EXECUTE original;
END $patch$;

DO $patch$
DECLARE original text;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure) INTO original;
 IF md5(original)<>'cd69f0dbdb7ead363220d4bc54c4277c' THEN RAISE EXCEPTION 'Diamond custody preimage changed: fn_ca_diamond_snapshot'; END IF;
 original:=replace(original,$old$(SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE public.fn_ca_is_fixture_account(user_id))$old$,$new$((SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE public.fn_ca_is_fixture_account(user_id)) + (SELECT COALESCE(sum(pending_diamonds),0) FROM public.diamond_spin_days WHERE status='open' AND public.fn_ca_is_fixture_account(owner_id)))$new$);
 EXECUTE original;
END $patch$;

DO $patch$
DECLARE original text;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_diamond_trial_balance(timestamp with time zone)'::regprocedure) INTO original;
 IF md5(original)<>'52bc0ea036ad5dcbc2662376c2dfefff' THEN RAISE EXCEPTION 'Diamond custody preimage changed: fn_ca_diamond_trial_balance'; END IF;
 original:=replace(original,'diamonds on the Diamond Arena felt (dedicated diamond custody). A deposit moves them out of ',
   'diamonds on the Diamond Arena felt plus signed unsettled Diamond Spin custody. A custody deposit moves them out of ');
 original:=replace(original,$old$(SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE public.fn_ca_is_fixture_account(user_id))$old$,$new$((SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE public.fn_ca_is_fixture_account(user_id)) + (SELECT COALESCE(sum(pending_diamonds),0) FROM public.diamond_spin_days WHERE status='open' AND public.fn_ca_is_fixture_account(owner_id)))$new$);
 EXECUTE original;
END $patch$;

DO $patch$
DECLARE original text;
BEGIN
 SELECT pg_get_functiondef('public.fn_wheel_state_v2(uuid,integer)'::regprocedure) INTO original;
 IF md5(original)<>'1844d82495f45b1970100b2025d7817f' THEN RAISE EXCEPTION 'Diamond custody preimage changed: fn_wheel_state_v2'; END IF;
 original:=replace(original,$old$SELECT COALESCE(diamonds,0) INTO owner_diamonds FROM public.profiles WHERE id=owner;$old$,$new$SELECT public.fn_diamond_spin_available(owner) INTO owner_diamonds;$new$);
 EXECUTE original;
END $patch$;

DO $patch$
DECLARE original text;
BEGIN
 SELECT pg_get_functiondef('public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid)'::regprocedure) INTO original;
 IF md5(original)<>'f9e14bfc80321ea10e999f37a15ac450' THEN RAISE EXCEPTION 'Diamond custody preimage changed: fn_wheel_spin_core'; END IF;
 original:=replace(original,$old$IF public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',false,'error','Refresh Diamond Spins To Use The New Wheel'); END IF;$old$,$new$RETURN jsonb_build_object('ok',false,'error','Refresh Diamond Spins To Use The New Wheel');$new$);
 EXECUTE original;
END $patch$;

DO $patch$
DECLARE original text;
BEGIN
 SELECT pg_get_functiondef('public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'::regprocedure) INTO original;
 IF md5(original)<>'3532309ad4075bbfdcc0a3029e4cbad8' THEN RAISE EXCEPTION 'Diamond custody preimage changed: fn_wheel_spin_v2'; END IF;
 original:=replace(original,$old$SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;$old$,$new$PERFORM 1 FROM public.profiles WHERE id IN(v_owner,v_user) ORDER BY id FOR UPDATE;
  SELECT public.fn_diamond_spin_available(v_owner) INTO v_owner_dia;$new$);
 original:=replace(original,$old$v_credit := public.add_diamonds_to_balance(v_owner, v_price, 'transfer',
                  format('Diamond Wheel Intake (%s Diamonds)', v_price), 'wheel:' || v_spin_id::text || ':intake', v_user);$old$,$new$v_credit := public.fn_diamond_spin_book(v_owner,p_club_id,v_host,v_kind,v_user,'entry',v_price,
                  'wheel:'||v_spin_id||':intake',format('Diamond Wheel Intake (%s Diamonds)',v_price));$new$);
 original:=replace(original,$old$PERFORM public.fn_diamond_game_pay_diamonds(v_owner,v_user,v_prize_dia,'Diamond Spins: Diamonds','wheel:'||v_spin_id||':prize');$old$,$new$PERFORM public.fn_diamond_spin_book(v_owner,p_club_id,v_host,v_kind,v_user,'diamond_prize',-v_prize_dia,
    'wheel:'||v_spin_id||':diamond-prize','Diamond Spins: Diamonds');
   v_credit:=public.add_diamonds_to_balance(v_user,v_prize_dia,'transfer','Diamond Spins: Diamonds','wheel:'||v_spin_id||':prize',v_owner);
   IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'The Diamond Prize Credit Failed'; END IF;$new$);
 original:=replace(original,$old$v_deduct:=public.add_diamonds_to_balance(v_owner,-v_cost,'deduction',
    'Diamond Spins: '||v_pick.label||' for '||v_user,'wheel:'||v_spin_id||':inventory',NULL);$old$,$new$v_deduct:=public.fn_diamond_spin_book(v_owner,p_club_id,v_host,v_kind,v_user,CASE v_feature WHEN 'time_bank_seconds' THEN 'time_bank' ELSE v_feature END,-(v_cost-v_remainder),
    'wheel:'||v_spin_id||':inventory','Diamond Spins: '||v_pick.label||' for '||v_user);
   IF v_remainder>0 THEN
    PERFORM public.fn_diamond_spin_book(v_owner,p_club_id,v_host,v_kind,v_user,'throwable',-v_remainder,
      'wheel:'||v_spin_id||':inventory-remainder','Diamond Spins: Throwable Remainder');
   END IF;$new$);
 EXECUTE original;
END $patch$;

DO $patch$
DECLARE original text;
BEGIN
 SELECT pg_get_functiondef('public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text)'::regprocedure) INTO original;
 IF md5(original)<>'4ea1b34c9b4cf97c9d69ab5669ee0bb7' THEN RAISE EXCEPTION 'Diamond custody preimage changed: fn_diamond_game_take_bet'; END IF;
 original:=replace(original,$old$v_deduct := public.deduct_diamonds(p_user, p_bet, p_description, p_type, 'diamond_game',$old$,$new$PERFORM 1 FROM public.profiles WHERE id IN(p_owner,p_user) ORDER BY id FOR UPDATE;
  v_deduct := public.deduct_diamonds(p_user, p_bet, p_description, p_type, 'diamond_game',$new$);
 original:=replace(original,$old$v_credit := public.add_diamonds_to_balance(p_owner, p_bet, 'transfer', p_owner_note, p_reference || ':intake', p_user);$old$,$new$v_credit := public.fn_diamond_spin_book(p_owner,(p_meta->>'club_id')::uuid,(p_meta->>'host_id')::uuid,
    (SELECT host_kind FROM public.fn_wheel_host((p_meta->>'club_id')::uuid)),p_user,'bonus',p_bet,p_reference||':intake',p_owner_note);$new$);
 EXECUTE original;
END $patch$;

DO $patch$
DECLARE original text;
BEGIN
 SELECT pg_get_functiondef('public.fn_diamond_bonus_spin_ticket_guard()'::regprocedure) INTO original;
 IF md5(original)<>'16a8ef3f7495b24ffa41b78289e75249' THEN RAISE EXCEPTION 'Diamond custody preimage changed: fn_diamond_bonus_spin_ticket_guard'; END IF;
 original:=replace(original,$old$m := public.fn_ca_mint('diamonds','player',NEW.owner_id,100,$old$,$new$m := public.fn_ca_mint('diamonds','player',NEW.user_id,100,$new$);
 original:=replace(original,$old$OR m->>'target_id' IS DISTINCT FROM NEW.owner_id::text THEN$old$,$new$OR m->>'target_id' IS DISTINCT FROM NEW.user_id::text THEN$new$);
 original:=replace(original,$old$ELSE
  IF (NEW.club_id$old$,$new$m:=public.deduct_diamonds(NEW.user_id,100,'Claimed Daily Bonus Spin Entry','daily_bonus_spin','diamond_game',
    jsonb_build_object('recipient_id',NEW.owner_id,'ticket_id',NEW.id),NEW.mint_op_id||':custody',0);
  IF COALESCE((m->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'Daily Spin Entry Transfer Failed'; END IF;
  PERFORM public.fn_diamond_spin_book(NEW.owner_id,NEW.club_id,NEW.host_id,NEW.host_kind,NEW.user_id,'mint_entry',100,
    NEW.mint_op_id||':intake','Mint Funded Claimed Daily Bonus Spin');
 ELSE
  IF (NEW.club_id$new$);
 EXECUTE original;
END $patch$;

REVOKE ALL ON FUNCTION public.fn_diamond_spin_immutable(),public.fn_diamond_spin_wallet_reserve(),public.fn_diamond_spin_settlement_receipt(),
 public.fn_diamond_spin_available(uuid),public.fn_diamond_spin_book(uuid,uuid,uuid,text,uuid,text,integer,text,text,date),
 public.fn_diamond_spin_settle_day(uuid,date),public.fn_diamond_spin_statements(date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_settle_day(uuid,date) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_statements(date) TO authenticated,service_role;
CREATE FUNCTION public.fn_diamond_spin_settle_daily(p_day date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d date:=COALESCE(p_day,(clock_timestamp() AT TIME ZONE 'America/Chicago')::date-1);
 r record;results jsonb:='[]'::jsonb;
BEGIN
 IF NOT public.fn_is_service_context() THEN RAISE EXCEPTION 'Daily Diamond Settlement Is Service Managed' USING ERRCODE='42501'; END IF;
 IF d>=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date THEN RAISE EXCEPTION 'Only A Closed Chicago Business Day Can Settle'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'Diamond Settlement Is Paused For Maintenance'; END IF;
 FOR r IN SELECT owner_id FROM public.diamond_spin_days WHERE day=d AND status='open' ORDER BY owner_id LOOP
  results:=results||public.fn_diamond_spin_settle_day(r.owner_id,d);
 END LOOP;
 RETURN jsonb_build_object('ok',true,'day',d,'timezone','America/Chicago','settlements',results);
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_spin_settle_daily(date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_settle_daily(date) TO service_role;

DO $patch$
DECLARE original text;
BEGIN
 SELECT pg_get_functiondef('public.deduct_diamonds(uuid,integer,text,text,text,jsonb,text,integer)'::regprocedure) INTO original;
 IF md5(original)<>'2e09367262d69d11380e3b649c3235c1' THEN RAISE EXCEPTION 'Diamond custody preimage changed: deduct_diamonds'; END IF;
 original:=replace(original,$old$PERFORM public.fn_ca_consume_purchase_lots(p_user_id, p_amount);$old$,$new$-- A claimed free-spin entry is freshly minted for this one transfer. It
    -- must not consume purchased lots the player already owned. The exception
    -- requires the actual ticket trigger and its exact canonical Mint receipt.
    IF NOT COALESCE((pg_trigger_depth()>0 AND p_amount=100 AND p_source='diamond_game'
      AND p_transaction_type='daily_bonus_spin'
      AND p_reference_id='daily-bonus-spin:'||(p_metadata->>'ticket_id')||':custody'
      AND EXISTS(SELECT 1 FROM public.diamond_bonus_spin_tickets t JOIN public.ca_mint_ledger m
        ON m.op_id='daily-bonus-spin:'||t.id
        WHERE t.id::text=p_metadata->>'ticket_id' AND t.user_id=p_user_id AND t.funded_at IS NULL
          AND m.action='mint' AND m.asset='diamonds' AND m.holder_type='player'
          AND m.holder_id=p_user_id AND m.amount=100)),false) THEN
      PERFORM public.fn_ca_consume_purchase_lots(p_user_id, p_amount);
    END IF;$new$);
 EXECUTE original;
END $patch$;
DO $guard$ BEGIN
 IF 'fn_ca_diamond_snapshot'=ANY(public.fn_ca_guard_watchlist()) THEN
  PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_diamond_snapshot',
   'migration 20260919150113_diamond_spin_daily_net_settlement');
 END IF;
END $guard$;
COMMIT;
