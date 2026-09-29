-- 20260921202834_diamond_spins_daily_settlement_burns_twenty_percent_of_a_pro.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (owner rulings 2026-09-21, R14 and R17):
--
-- R14. "One transaction at the end of every day awards the profit diamonds to
-- the club or union owner's account; add a 20% profit burn that removes 20% of
-- all earned diamonds at the end of each day."
--
-- The single daily transaction already exists (20260919152614,
-- fn_diamond_spin_settle_day). What changes is the amount and the register:
--   net       = entries + Double Down + Mint entries - diamond prizes - inventory
--               (unchanged; the bucket identity CHECK still enforces it)
--   burn      = floor(net * 2000 / 10000) whole diamonds when net > 0, else 0
--               (never more than 20%; the rate lives in ONE place,
--               fn_diamond_spin_profit_burn_bps(), and the arithmetic in ONE
--               place, fn_diamond_spin_profit_burn(net, bps))
--   credited  = net - burn, paid to the owner wallet in the ONE existing
--               'transfer' journal row (reference diamond-spin-day:<owner>:<day>)
-- A zero or negative day burns nothing and settles exactly as before.
--
-- The burn is booked the way this estate already books a retirement of custody
-- supply (20260919152614:160-170, the inventory burn): one ca_mint_ledger row,
-- action 'burn', asset 'diamonds', holder_type 'player', holder_id the owner,
-- op_id 'diamond-spin-burn:<owner>:<day>' (UNIQUE, so a duplicate is impossible
-- by construction). The trial balance identity therefore still holds with no
-- new account: players +80, arena custody -100, player register -20 nets to 0,
-- and fn_ca_mint_supply falls by exactly the burn. Nothing is burned by
-- omission (DIAMOND-ACCOUNTING-STANDARD D14, D17, DR14).
--
-- The day row records it: profit_burn_bps (the rate applied THAT day),
-- profit_burn, and credited_net GENERATED ALWAYS AS (settled_net - profit_burn),
-- with a CHECK tying profit_burn to fn_diamond_spin_profit_burn(settled_net,
-- profit_burn_bps). The deferred receipt trigger now proves, at commit, that the
-- wallet row equals credited_net, that a burn row of exactly profit_burn exists
-- when it should and does not when it should not, that the rate applied is the
-- current rate, and that the statement notification carries all three figures.
--
-- NO RETROACTIVE BURN. Days settled before this migration keep profit_burn 0,
-- profit_burn_bps 0 and credited_net = settled_net through the column
-- defaults; the ADD CONSTRAINT validates them and the open day in place. Read
-- from production 2026-09-21: one settled day (2026-09-20, net 12,400, paid in
-- full) and one open day (2026-09-21). Neither is rewritten.
--
-- R17 (settlement half). The once-a-day statement notification stays (the day
-- row requires notification_id) but must not reach the phone: its data now
-- carries '_push':'ledger_only', the key fn_mirror_notification_to_push_outbox
-- already honours (20260914141405:82), and the receipt trigger refuses a
-- settlement whose notification lacks it or that produced a push_outbox row.
--
-- OWNER TERMS. The owner agreement gates play in three functions on the
-- literal receipt 'diamond-spins-2026-09-14-v1' (fn_diamond_spins_owner_agreed,
-- fn_wheel_spin_v2/state through it, and an inline check in
-- fn_diamond_game_admit). Bumping that literal would switch every host OFF
-- until its owner taps accept, which is an outage, not a consent flow. So the
-- gate is untouched and the burn is published as a second, immutable receipt:
-- version 'diamond-spins-2026-09-21-v2' is a dated ADDENDUM to the base
-- agreement. fn_diamond_spins_owner_terms now returns the base agreement (v1)
-- and the addendum (v2) with their own accepted flags; p_agree records the
-- addendum for an owner who already holds the base receipt, and records both
-- for a new host owner who reads both. The burn applies to every day settled
-- after installation whether or not the addendum has been acknowledged, and
-- the addendum says so.
--
-- Every function replaced here is guarded by the md5 of its installed
-- definition, continuing the chain the Diamond Spins migrations use.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='3s';

-- ---------------------------------------------------------------------------
-- 0. Preimages. Refuse loudly if anything below is not what this was written against.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE expected jsonb:=jsonb_build_object(
  'public.fn_diamond_spin_settle_day(uuid,date)','5ba56d462ed9f00569618fc78a50b949',
  'public.fn_diamond_spin_settlement_receipt()','524756408765b727ee2320e35705384e',
  'public.fn_diamond_spin_statements(date)','ee2f7f94ed652b3a7748472ba3d7cea8',
  'public.fn_diamond_spins_owner_terms(uuid,boolean)','3240b38f3ac4818a7e6ada0342a4dd1c');
 k text; actual text;
BEGIN
 FOR k IN SELECT jsonb_object_keys(expected) LOOP
  SELECT md5(pg_get_functiondef(k::regprocedure)) INTO actual;
  IF actual<>expected->>k THEN RAISE EXCEPTION 'Diamond settlement preimage changed: % (md5 %)',k,actual; END IF;
 END LOOP;
 IF to_regprocedure('public.fn_diamond_spin_profit_burn_bps()') IS NOT NULL
  OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='diamond_spin_days' AND column_name IN('profit_burn','profit_burn_bps','credited_net')) THEN
  RAISE EXCEPTION 'The daily profit burn is already installed';
 END IF;
END $guard$;

-- ---------------------------------------------------------------------------
-- 1. The rate and the arithmetic, each in one place.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_diamond_spin_profit_burn_bps() RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$ SELECT 2000 $$;
COMMENT ON FUNCTION public.fn_diamond_spin_profit_burn_bps() IS
 'Basis points of a profitable Diamond Spins day burned at settlement: 2000 = 20% (owner ruling 2026-09-21 R14). The only place the rate is written.';
CREATE FUNCTION public.fn_diamond_spin_profit_burn(p_net bigint,p_bps integer) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_net>0 AND p_bps>0 THEN (p_net*p_bps)/10000 ELSE 0 END
$$;
COMMENT ON FUNCTION public.fn_diamond_spin_profit_burn(bigint,integer) IS
 'Whole diamonds burned from a settled Diamond Spins day: floor(net * bps / 10000) when the net is positive, else 0. Integer division floors, so the burn is never more than the rate.';
REVOKE ALL ON FUNCTION public.fn_diamond_spin_profit_burn_bps(),public.fn_diamond_spin_profit_burn(bigint,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_profit_burn_bps(),public.fn_diamond_spin_profit_burn(bigint,integer) TO authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 2. The day row records the burn. Existing rows (settled before today and the
--    open day) take the defaults: rate 0, burn 0, credited = net. No row is
--    updated, so the immutability trigger has nothing to refuse.
-- ---------------------------------------------------------------------------
ALTER TABLE public.diamond_spin_days
 ADD COLUMN profit_burn_bps integer NOT NULL DEFAULT 0 CHECK(profit_burn_bps BETWEEN 0 AND 10000),
 ADD COLUMN profit_burn bigint NOT NULL DEFAULT 0 CHECK(profit_burn>=0),
 ADD COLUMN credited_net bigint GENERATED ALWAYS AS (settled_net-profit_burn) STORED,
 ADD CONSTRAINT diamond_spin_days_profit_burn_identity CHECK(
  (status='open' AND profit_burn_bps=0 AND profit_burn=0)
  OR (status IN('settling','settled') AND profit_burn=public.fn_diamond_spin_profit_burn(settled_net,profit_burn_bps)));
COMMENT ON COLUMN public.diamond_spin_days.profit_burn_bps IS 'Burn rate applied when this day settled (0 for a day settled before 20260921202834 or still open; fn_diamond_spin_profit_burn_bps() since).';
COMMENT ON COLUMN public.diamond_spin_days.profit_burn IS 'Whole diamonds retired from custody supply at settlement: fn_diamond_spin_profit_burn(settled_net, profit_burn_bps). Booked as ca_mint_ledger burn diamond-spin-burn:<owner>:<day>.';
COMMENT ON COLUMN public.diamond_spin_days.credited_net IS 'What the one daily wallet transaction actually moved: settled_net - profit_burn. Equals settled_net on a zero, negative or pre-burn day.';

-- ---------------------------------------------------------------------------
-- 3. Settlement: net, burn, one register row, one wallet row, one quiet notice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_diamond_spin_settle_day(p_owner uuid,p_day date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bucket public.diamond_spin_days;paid jsonb;notice uuid:=gen_random_uuid();target_club uuid;
 total numeric;movement_total bigint;v_net integer;v_reference text;
 v_bps integer:=public.fn_diamond_spin_profit_burn_bps();v_burn bigint;v_credit integer;v_burn_op text;v_supply numeric;
BEGIN
 IF NOT public.fn_is_service_context() THEN RAISE EXCEPTION 'Daily Diamond Settlement Is Service Managed' USING ERRCODE='42501'; END IF;
 IF p_owner IS NULL OR p_day IS NULL OR p_day>=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date THEN
  RAISE EXCEPTION 'Only A Closed Chicago Business Day Can Settle'; END IF;
 PERFORM 1 FROM public.profiles WHERE id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'The Diamond Spin Owner Wallet Is Missing'; END IF;
 SELECT * INTO bucket FROM public.diamond_spin_days WHERE owner_id=p_owner AND day=p_day FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'empty',true,'day',p_day); END IF;
 IF bucket.status='settled' THEN RETURN jsonb_build_object('ok',true,'replayed',true,'day',p_day,'net_diamonds',bucket.settled_net,
  'profit_burn',bucket.profit_burn,'profit_burn_bps',bucket.profit_burn_bps,'credited_net',bucket.credited_net,
  'wallet_transaction_id',bucket.wallet_transaction_id,'notification_id',bucket.notification_id); END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'Diamond Settlement Is Paused For Maintenance'; END IF;
 SELECT COALESCE(sum(amount),0),count(*) INTO total,movement_total FROM public.diamond_spin_movements WHERE owner_id=p_owner AND day=p_day;
 IF total IS DISTINCT FROM bucket.pending_diamonds OR movement_total IS DISTINCT FROM bucket.movement_count THEN
  RAISE EXCEPTION 'Diamond Spin Statement Does Not Match Its Movements'; END IF;
 v_net:=bucket.pending_diamonds::integer;
 v_burn:=public.fn_diamond_spin_profit_burn(v_net,v_bps);
 v_credit:=v_net-v_burn;
 v_reference:='diamond-spin-day:'||p_owner||':'||p_day;
 v_burn_op:='diamond-spin-burn:'||p_owner||':'||p_day;
 -- Release exactly this day's balance before the canonical wallet writer checks
 -- other days' reserves. All state, register, wallet, statement and notification
 -- commit together. A placeholder transaction ID is replaced below in the same
 -- transaction; no externally visible half-settlement is possible.
 UPDATE public.diamond_spin_days SET status='settling',pending_diamonds=0,settled_net=v_net,
  profit_burn_bps=v_bps,profit_burn=v_burn,
  settled_at=clock_timestamp(),wallet_transaction_id=CASE WHEN v_credit<>0 THEN notice END,notification_id=notice
  WHERE owner_id=p_owner AND day=p_day;
 IF v_burn>0 THEN
  -- The platform's share of a profitable day leaves custody and reaches no
  -- wallet: it is retired in the canonical Mint register, exactly as consumed
  -- inventory already is, so the supply falls by the burn and nothing is burned
  -- by omission. UNIQUE(op_id) makes a second burn for the same day impossible.
  SELECT public.fn_ca_mint_supply('diamonds')-v_burn INTO v_supply;
  INSERT INTO public.ca_mint_ledger(op_id,action,asset,holder_type,holder_id,holder_label,amount,
   balance_before,balance_after,supply_after,reason,performed_by,performed_by_label)
  VALUES(v_burn_op,'burn','diamonds','player',p_owner,
   COALESCE((SELECT username FROM public.profiles WHERE id=p_owner),p_owner::text),v_burn,
   v_net,v_credit,v_supply,format('Diamond Spins Daily Profit Burn (%s%%) For %s',v_bps/100,p_day),
   auth.uid(),COALESCE((SELECT username FROM public.profiles WHERE id=auth.uid()),auth.uid()::text));
 END IF;
 IF v_credit<>0 THEN
  paid:=public.add_diamonds_to_balance(p_owner,v_credit,'transfer',
    'Diamond Spins Daily Net Settlement For '||p_day,v_reference,p_owner);
  IF COALESCE((paid->>'success')::boolean,false) IS NOT TRUE THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Failed: %',COALESCE(paid->>'error','unknown'); END IF;
 END IF;
 SELECT club_id INTO target_club FROM public.diamond_spin_movements WHERE owner_id=p_owner AND day=p_day ORDER BY created_at,id LIMIT 1;
 -- One statement a day, in the app only: '_push' keeps it out of push_outbox
 -- (owner ruling 2026-09-21 R17). The ledger is the record.
 INSERT INTO public.notifications(id,user_id,type,title,message,data,action_url,link)
 VALUES(notice,p_owner,'diamond_spin_settlement','Diamond Spins Daily Statement',
  format('%s Diamonds Net For %s. Platform Burn (%s%%): %s. Credited To Your Wallet: %s. Entries: %s. Prizes And Inventory: %s.',v_net,p_day,v_bps/100,v_burn,v_credit,
   bucket.entry_diamonds+bucket.bonus_diamonds+bucket.mint_entry_diamonds,
   bucket.diamond_prizes+bucket.throwables+bucket.time_banks+bucket.rabbit_hunts+bucket.other_expenses),
  jsonb_build_object('day',p_day,'timezone','America/Chicago','net_diamonds',v_net,'profit_burn',v_burn,'profit_burn_bps',v_bps,
   'credited_net',v_credit,'club_id',target_club,'wallet_transaction_id',paid->>'transaction_id','burn_op_id',CASE WHEN v_burn>0 THEN v_burn_op END,
   '_push','ledger_only'),
  '/hub/club-arena/clubs/'||target_club||'/diamond-games-operations',
  '/hub/club-arena/clubs/'||target_club||'/diamond-games-operations');
 -- The legal open-to-settled transition is performed once by the actual writer;
 -- finalized receipts are never updated afterward (trigger recognizes this local phase).
 UPDATE public.diamond_spin_days SET status='settled',wallet_transaction_id=(paid->>'transaction_id')::uuid
 WHERE owner_id=p_owner AND day=p_day;
 RETURN jsonb_build_object('ok',true,'day',p_day,'net_diamonds',v_net,'profit_burn',v_burn,'profit_burn_bps',v_bps,'credited_net',v_credit,
  'wallet_transaction_id',paid->>'transaction_id','notification_id',notice);
END $$;

-- ---------------------------------------------------------------------------
-- 4. The deferred receipt proves the wallet row, the burn row, the rate and the
--    quiet notification together at commit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_diamond_spin_settlement_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.diamond_spin_days;burn_rows integer;
BEGIN
 SELECT * INTO d FROM public.diamond_spin_days WHERE owner_id=NEW.owner_id AND day=NEW.day;
 IF d.status='settling' THEN RAISE EXCEPTION 'Diamond Spin Settlement Is Incomplete'; END IF;
 IF d.status='settled' THEN
  IF d.profit_burn_bps<>public.fn_diamond_spin_profit_burn_bps()
   OR d.profit_burn<>public.fn_diamond_spin_profit_burn(d.settled_net,d.profit_burn_bps)
   OR d.credited_net<>d.settled_net-d.profit_burn THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Burn Is Not The Current Rate'; END IF;
  IF d.credited_net<>0 AND NOT EXISTS(SELECT 1 FROM public.diamond_transactions t
   WHERE t.id=d.wallet_transaction_id AND t.user_id=d.owner_id AND t.amount=d.credited_net
    AND t.reference_id='diamond-spin-day:'||d.owner_id||':'||d.day AND t.issuance_class='transferred') THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Has No Matching Wallet Receipt'; END IF;
  IF d.credited_net=0 AND d.wallet_transaction_id IS NOT NULL THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Has A Wallet Receipt For Nothing'; END IF;
  SELECT count(*) INTO burn_rows FROM public.ca_mint_ledger m
   WHERE m.op_id='diamond-spin-burn:'||d.owner_id||':'||d.day AND m.action='burn' AND m.asset='diamonds'
    AND m.holder_type='player' AND m.holder_id=d.owner_id AND m.amount=d.profit_burn;
  IF (d.profit_burn>0 AND burn_rows<>1) OR (d.profit_burn=0 AND EXISTS(SELECT 1 FROM public.ca_mint_ledger m WHERE m.op_id='diamond-spin-burn:'||d.owner_id||':'||d.day)) THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Has No Matching Profit Burn'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.id=d.notification_id AND n.user_id=d.owner_id
   AND n.type='diamond_spin_settlement' AND n.data->>'day'=d.day::text
   AND (n.data->>'net_diamonds')::bigint=d.settled_net
   AND (n.data->>'profit_burn')::bigint=d.profit_burn
   AND (n.data->>'credited_net')::bigint=d.credited_net
   AND n.data->>'_push' IS NOT NULL) THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Has No Matching Notification'; END IF;
  IF EXISTS(SELECT 1 FROM public.push_outbox p WHERE p.related_entity_id=d.notification_id OR p.accounting_notification_id=d.notification_id) THEN
   RAISE EXCEPTION 'Diamond Spin Settlement Must Not Push To The Phone'; END IF;
 END IF;
 RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. The owner statement shows the three lines.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_diamond_spin_statements(p_before_day date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid();days jsonb;last_day date;n integer;
BEGIN
 IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To View Diamond Statements'); END IF;
 WITH selected AS (SELECT * FROM public.diamond_spin_days WHERE owner_id=v_user AND (p_before_day IS NULL OR day<p_before_day) ORDER BY day DESC LIMIT 31),
 rows AS (SELECT s.day,jsonb_build_object('day',s.day,'status',s.status,'entry_diamonds',s.entry_diamonds,
 'bonus_diamonds',s.bonus_diamonds,'mint_entry_diamonds',s.mint_entry_diamonds,'diamond_prizes',s.diamond_prizes,
 'throwables',s.throwables,'time_banks',s.time_banks,'rabbit_hunts',s.rabbit_hunts,'other_expenses',s.other_expenses,
 'net_diamonds',CASE WHEN s.status='open' THEN s.pending_diamonds ELSE s.settled_net END,
 'profit_burn_bps',CASE WHEN s.status='open' THEN NULL ELSE s.profit_burn_bps END,
 'profit_burn',CASE WHEN s.status='open' THEN NULL ELSE s.profit_burn END,
 'credited_net',CASE WHEN s.status='open' THEN NULL ELSE s.credited_net END,
 'settled_at',s.settled_at,'wallet_transaction_id',s.wallet_transaction_id,
 'hosts',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.host_kind,t.host_id) FROM
  (SELECT host_id,host_kind,CASE WHEN host_kind='union' THEN (SELECT name FROM public.unions WHERE id=host_id)
     ELSE (SELECT name FROM public.clubs WHERE id=host_id) END host_name,array_agg(DISTINCT club_id) club_ids,
    sum(GREATEST(amount,0)) entries,sum(GREATEST(-amount,0)) expenses,sum(amount) net_diamonds
   FROM public.diamond_spin_movements WHERE owner_id=v_user AND day=s.day GROUP BY host_id,host_kind) t),'[]'::jsonb)) item FROM selected s)
 SELECT COALESCE(jsonb_agg(item ORDER BY day DESC),'[]'::jsonb),min(day),count(*) INTO days,last_day,n FROM rows;
 RETURN jsonb_build_object('ok',true,'timezone','America/Chicago','profit_burn_bps',public.fn_diamond_spin_profit_burn_bps(),
  'days',days,'next_before_day',CASE WHEN n=31 THEN last_day END);
END $$;

-- ---------------------------------------------------------------------------
-- 6. The owner agreement: base receipt untouched (it gates play), burn addendum
--    published as its own receipt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_diamond_spins_owner_terms(p_club_id uuid,p_agree boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE h uuid; k text; v_owner uuid; receipt public.diamond_spins_owner_consents; addendum public.diamond_spins_owner_consents;
 base_version constant text:='diamond-spins-2026-09-14-v1';
 addendum_version constant text:='diamond-spins-2026-09-21-v2';
 terms text:='I Authorize Diamond Spins For This Host. Player Diamond Entries Go To My Owner Diamond Wallet. Chip Prizes Use The BBJ-Funded Promo Wallet First, With The Union Main Bank Covering Any Shortfall, Or The Club Main Bank For A Standalone Club. My Owner Diamond Wallet Pays For Awarded Throwables, Time Banks, Rabbit Hunts, Eligible One-Day VIP Cards, And VIP Diamond Multiplier Rewards At Their Recorded Diamond Cost. A Reward Must Be Funded Before It Is Awarded.';
 addendum_text text:='Daily Settlement And Profit Burn Addendum, September 21, 2026. Player Diamond Entries And Double Down Add Ons Are Held In Daily Custody For This Host, And Diamond Prizes, Throwables, Time Banks And Rabbit Hunts Are Deducted From That Custody As They Are Awarded. Each Chicago Business Day Settles In One Wallet Transaction After Midnight. On A Day With A Positive Net, The Platform Burns '||(public.fn_diamond_spin_profit_burn_bps()/100)||'% Of The Net Diamonds, Rounded Down To Whole Diamonds, And Credits The Remaining '||(100-public.fn_diamond_spin_profit_burn_bps()/100)||'% To My Owner Diamond Wallet. A Day With Zero Or Negative Net Burns Nothing, And A Negative Net Is Paid From My Owner Diamond Wallet. The Burn Applies To Every Day Settled From The Date This Addendum Is Published, Whether Or Not I Have Acknowledged It. Where This Addendum Differs From The Agreement Above, This Addendum Applies.';
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In First'); END IF;
 SELECT host_id,host_kind INTO h,k FROM public.fn_wheel_host(p_club_id);
 IF h IS NULL THEN RETURN jsonb_build_object('ok',false,'error','That Club Could Not Be Found'); END IF;
 v_owner:=public.fn_diamond_game_owner(h,k);
 IF v_owner IS NULL THEN RETURN jsonb_build_object('ok',false,'error','The Host Wallet Owner Is Not Set'); END IF;
 IF auth.uid() IS DISTINCT FROM v_owner AND NOT public.fn_wheel_can_operate(h,k,auth.uid()) THEN
  RETURN jsonb_build_object('ok',false,'error','Only This Host Can Read Its Agreement'); END IF;
 IF p_agree IS TRUE THEN
  IF auth.uid() IS DISTINCT FROM v_owner THEN
   RETURN jsonb_build_object('ok',false,'error','The Wallet Owner Must Accept This Agreement'); END IF;
  -- Both texts are shown together; a new host owner accepts both, an owner who
  -- already holds the base receipt acknowledges the addendum. Receipts are
  -- permanent, so an existing one is never rewritten.
  INSERT INTO public.diamond_spins_owner_consents(host_id,host_kind,owner_id,terms_version,terms_text)
   VALUES(h,k,v_owner,base_version,terms) ON CONFLICT DO NOTHING;
  INSERT INTO public.diamond_spins_owner_consents(host_id,host_kind,owner_id,terms_version,terms_text)
   VALUES(h,k,v_owner,addendum_version,addendum_text) ON CONFLICT DO NOTHING;
 END IF;
 SELECT * INTO receipt FROM public.diamond_spins_owner_consents c WHERE c.host_id=h
  AND c.owner_id=v_owner AND c.terms_version=base_version;
 SELECT * INTO addendum FROM public.diamond_spins_owner_consents c WHERE c.host_id=h
  AND c.owner_id=v_owner AND c.terms_version=addendum_version;
 RETURN jsonb_build_object('ok',true,'host_id',h,'host_kind',k,'is_owner',auth.uid()=v_owner,
  'accepted',receipt.host_id IS NOT NULL,'accepted_at',receipt.accepted_at,'terms',terms,
  'terms_version',base_version,
  'addendum',jsonb_build_object('version',addendum_version,'text',addendum_text,
   'accepted',addendum.host_id IS NOT NULL,'accepted_at',addendum.accepted_at,
   'profit_burn_bps',public.fn_diamond_spin_profit_burn_bps()),
  'acknowledged',receipt.host_id IS NOT NULL AND addendum.host_id IS NOT NULL);
END $$;

REVOKE ALL ON FUNCTION public.fn_diamond_spin_settle_day(uuid,date),public.fn_diamond_spin_settlement_receipt(),
 public.fn_diamond_spin_statements(date),public.fn_diamond_spins_owner_terms(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_settle_day(uuid,date) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_statements(date) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spins_owner_terms(uuid,boolean) TO authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 7. Read the change back inside the same transaction.
-- ---------------------------------------------------------------------------
DO $readback$
DECLARE src text;bad bigint;
BEGIN
 IF public.fn_diamond_spin_profit_burn_bps()<>2000
  OR public.fn_diamond_spin_profit_burn(100,2000)<>20 OR public.fn_diamond_spin_profit_burn(99,2000)<>19
  OR public.fn_diamond_spin_profit_burn(4,2000)<>0 OR public.fn_diamond_spin_profit_burn(5,2000)<>1
  OR public.fn_diamond_spin_profit_burn(0,2000)<>0 OR public.fn_diamond_spin_profit_burn(-100,2000)<>0
  OR public.fn_diamond_spin_profit_burn(12400,2000)<>2480 OR public.fn_diamond_spin_profit_burn(12400,0)<>0 THEN
  RAISE EXCEPTION 'The profit burn arithmetic is wrong'; END IF;
 SELECT count(*) INTO bad FROM public.diamond_spin_days
  WHERE profit_burn<>0 OR profit_burn_bps<>0 OR (status<>'open' AND credited_net IS DISTINCT FROM settled_net) OR (status='open' AND credited_net IS NOT NULL);
 IF bad<>0 THEN RAISE EXCEPTION '% existing Diamond Spin day(s) were given a retroactive burn',bad; END IF;
 src:=pg_get_functiondef('public.fn_diamond_spin_settle_day(uuid,date)'::regprocedure);
 IF position($n$'diamond-spin-burn:'||p_owner||':'||p_day$n$ IN src)=0 OR position($n$'_push','ledger_only'$n$ IN src)=0
  OR position($n$public.add_diamonds_to_balance(p_owner,v_credit,'transfer',$n$ IN src)=0
  OR (length(src)-length(replace(src,'add_diamonds_to_balance','')))/length('add_diamonds_to_balance')<>1 THEN
  RAISE EXCEPTION 'fn_diamond_spin_settle_day was not installed with the burn, the quiet notice and the single wallet writer'; END IF;
 src:=pg_get_functiondef('public.fn_diamond_spin_settlement_receipt()'::regprocedure);
 IF position('Diamond Spin Settlement Has No Matching Profit Burn' IN src)=0 OR position('Diamond Spin Settlement Must Not Push To The Phone' IN src)=0 THEN
  RAISE EXCEPTION 'fn_diamond_spin_settlement_receipt was not installed with the burn and push proofs'; END IF;
 src:=pg_get_functiondef('public.fn_diamond_spins_owner_terms(uuid,boolean)'::regprocedure);
 IF position('diamond-spins-2026-09-21-v2' IN src)=0 OR position('diamond-spins-2026-09-14-v1' IN src)=0 OR position('Daily Settlement And Profit Burn Addendum' IN src)=0 THEN
  RAISE EXCEPTION 'fn_diamond_spins_owner_terms was not installed with the addendum'; END IF;
 IF has_function_privilege('authenticated','public.fn_diamond_spin_settle_day(uuid,date)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.fn_diamond_spin_statements(date)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.fn_diamond_spins_owner_terms(uuid,boolean)','EXECUTE') THEN
  RAISE EXCEPTION 'Diamond settlement grants are wrong'; END IF;
END $readback$;

COMMIT;
