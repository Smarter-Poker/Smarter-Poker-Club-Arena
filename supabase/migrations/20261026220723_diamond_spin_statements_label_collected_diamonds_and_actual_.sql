-- Clear units in Diamond Spins statements, including actual funded chip payouts.
-- Reserved by scripts/new-migration.mjs. This changes reporting only: no payout,
-- balance, burn, settled day receipt, idempotency or quiet-delivery rule changes.
-- @live-proof: md5(pg_get_functiondef('public.fn_diamond_spin_settle_day(uuid,date)'::regprocedure))='c6170e30922484b15fe0b53376b8099d' AND md5(pg_get_functiondef('public.fn_diamond_spin_chip_payouts(uuid,date)'::regprocedure))='a1bde2422bc0e840c64f3c3e88547498' AND md5(pg_get_functiondef('public.fn_diamond_spin_statement_message(date,bigint,numeric,bigint,bigint,bigint,integer,bigint,bigint)'::regprocedure))='34115edda647f0bd1a611727fc5b9e40'
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';

-- Read the canonical paying legs, NOT outcome_amount, prize_value_chips, bonus
-- face values or chips_minted. Promo + bank split legs add to one actual prize.
-- Include all five games, welcome spins and bonus redemptions on the PAYOUT day.
-- Day receipts preserve historical host ownership. If ownership changed within
-- that day, do not invent an allocation: NULL renders explicitly Unavailable.
-- A host with no diamond movements (e.g. welcome only) uses its current owner
-- when the closed day's statement is generated; the resulting total is saved.
CREATE FUNCTION public.fn_diamond_spin_chip_payouts(p_owner uuid,p_day date) RETURNS numeric
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 WITH hosts AS (
  SELECT DISTINCT m.host_id,m.host_kind FROM public.diamond_spin_movements m
   WHERE m.owner_id=p_owner AND m.day=p_day
  UNION
  SELECT c.id,'club' FROM public.clubs c WHERE c.owner_id=p_owner AND NOT EXISTS (
   SELECT 1 FROM public.diamond_spin_movements m WHERE m.day=p_day AND m.host_id=c.id AND m.host_kind='club')
  UNION
  SELECT u.id,'union' FROM public.unions u WHERE u.owner_id=p_owner AND NOT EXISTS (
   SELECT 1 FROM public.diamond_spin_movements m WHERE m.day=p_day AND m.host_id=u.id AND m.host_kind='union')
 ), stores AS (
  SELECT h.*,CASE WHEN h.host_kind='union' THEN u.id ELSE h.host_id END AS store_id
  FROM hosts h LEFT JOIN public.union_wallets u ON h.host_kind='union' AND u.union_id=h.host_id
 )
 SELECT CASE WHEN bool_or(o.owners>1 AND paid.rows>0) THEN NULL ELSE COALESCE(sum(paid.chips),0) END
 FROM stores h CROSS JOIN LATERAL (
  SELECT count(DISTINCT m.owner_id) AS owners FROM public.diamond_spin_movements m
  WHERE m.day=p_day AND m.host_id=h.host_id AND m.host_kind=h.host_kind
 ) o CROSS JOIN LATERAL (
  -- Drive the existing (from_entity_id,created_at) index once per paying store.
  -- OFFSET 0 retains this bounded parameterized lookup instead of a day-wide scan.
  SELECT sum(l.amount) AS chips,count(*) AS rows FROM public.chip_ledger l
  WHERE l.from_entity_id=h.store_id
    AND l.created_at >= (p_day::timestamp AT TIME ZONE 'America/Chicago')
    AND l.created_at < ((p_day+1)::timestamp AT TIME ZONE 'America/Chicago')
    AND public.fn_diamond_spin_ledger_category(l.category)
    AND l.status='posted' AND l.to_type='player_wallet'
    AND ((h.host_kind='union' AND l.from_type IN ('union_wallet','union_bank') AND l.union_id=h.host_id)
     OR (h.host_kind='club' AND l.from_type IN ('promo_wallet','club_treasury')))
  OFFSET 0
 ) paid;
$$;
REVOKE ALL ON FUNCTION public.fn_diamond_spin_chip_payouts(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_chip_payouts(uuid,date) TO service_role;

CREATE FUNCTION public.fn_diamond_spin_statement_message(p_day date,p_collected bigint,p_chips numeric,
 p_prizes bigint,p_inventory bigint,p_net bigint,p_bps integer,p_burn bigint,p_credit bigint) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT format('%s (Chicago). Diamonds Collected: %s Diamonds. Chip Payouts: %s (Paid Separately). Diamond Prizes: %s Diamonds. Inventory Costs: %s Diamonds. Net Before Burn: %s Diamonds. Platform Burn (%s%%): %s Diamonds. Your Net %s: %s Diamonds.',
  p_day,to_char(p_collected,'FM999,999,999,999,999,990'),
  CASE WHEN p_chips IS NULL THEN 'Unavailable' ELSE to_char(p_chips,'FM999,999,999,999,990.00')||' Chips' END,
  to_char(p_prizes,'FM999,999,999,999,999,990'),to_char(p_inventory,'FM999,999,999,999,999,990'),
  to_char(p_net,'FM999,999,999,999,999,990'),trim(trailing '.' from to_char(p_bps::numeric/100,'FM990.99')),
  to_char(p_burn,'FM999,999,999,999,999,990'),CASE WHEN p_credit<0 THEN 'Debit' ELSE 'Credit' END,
  to_char(abs(p_credit),'FM999,999,999,999,999,990'));
$$;
REVOKE ALL ON FUNCTION public.fn_diamond_spin_statement_message(date,bigint,numeric,bigint,bigint,bigint,integer,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_statement_message(date,bigint,numeric,bigint,bigint,bigint,integer,bigint,bigint) TO service_role;

DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_diamond_spin_settle_day(uuid,date)'::regprocedure)) IS DISTINCT FROM '847fb068b5bef85494181e6be8be28c8' THEN
  RAISE EXCEPTION 'diamond_statement_settler_preimage_changed'; END IF;
 IF has_function_privilege('anon','public.fn_diamond_spin_settle_day(uuid,date)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_diamond_spin_settle_day(uuid,date)','EXECUTE') THEN
  RAISE EXCEPTION 'diamond_statement_settler_authority_changed'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_diamond_spin_settle_day(p_owner uuid,p_day date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bucket public.diamond_spin_days;paid jsonb;notice uuid:=gen_random_uuid();target_club uuid;
 total numeric;movement_total bigint;v_net integer;v_reference text;
 v_bps integer:=public.fn_diamond_spin_profit_burn_bps();v_burn bigint;v_credit integer;v_burn_op text;v_supply numeric;v_chips numeric;
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
 v_chips:=public.fn_diamond_spin_chip_payouts(p_owner,p_day);
 INSERT INTO public.notifications(id,user_id,type,title,message,data,action_url,link)
 VALUES(notice,p_owner,'diamond_spin_settlement','Diamond Spins Daily Statement',
  public.fn_diamond_spin_statement_message(p_day,
   bucket.entry_diamonds+bucket.bonus_diamonds+bucket.mint_entry_diamonds,v_chips,
   bucket.diamond_prizes,bucket.throwables+bucket.time_banks+bucket.rabbit_hunts+bucket.other_expenses,
   v_net,v_bps,v_burn,v_credit),
  jsonb_build_object('day',p_day,'timezone','America/Chicago','net_diamonds',v_net,'profit_burn',v_burn,'profit_burn_bps',v_bps,
   'credited_net',v_credit,'club_id',target_club,'wallet_transaction_id',paid->>'transaction_id','burn_op_id',CASE WHEN v_burn>0 THEN v_burn_op END,
   'statement_version',2,'diamonds_collected',bucket.entry_diamonds+bucket.bonus_diamonds+bucket.mint_entry_diamonds,
   'chip_payouts',v_chips,'diamond_prizes',bucket.diamond_prizes,
   'inventory_cost_diamonds',bucket.throwables+bucket.time_banks+bucket.rabbit_hunts+bucket.other_expenses,
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

REVOKE ALL ON FUNCTION public.fn_diamond_spin_settle_day(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spin_settle_day(uuid,date) TO service_role;

-- Correct the display copies already issued, including the owner's screenshot.
-- Never re-settle a day, resend a notice or modify any financial receipt.
-- Only the original day-linked notification is eligible. Preserve read state,
-- route, identifiers, legacy burn rate and all original metadata keys.
WITH display AS (
 SELECT d.*,public.fn_diamond_spin_chip_payouts(d.owner_id,d.day) AS chips
 FROM public.diamond_spin_days d
 WHERE d.status='settled' AND d.notification_id IS NOT NULL
)
UPDATE public.notifications n SET
 message=public.fn_diamond_spin_statement_message(d.day,
  d.entry_diamonds+d.bonus_diamonds+d.mint_entry_diamonds,d.chips,d.diamond_prizes,
  d.throwables+d.time_banks+d.rabbit_hunts+d.other_expenses,
  d.settled_net,d.profit_burn_bps,d.profit_burn,d.credited_net),
 data=COALESCE(n.data,'{}'::jsonb)||jsonb_build_object('statement_version',2,
  'diamonds_collected',d.entry_diamonds+d.bonus_diamonds+d.mint_entry_diamonds,
  'chip_payouts',d.chips,'diamond_prizes',d.diamond_prizes,
  'inventory_cost_diamonds',d.throwables+d.time_banks+d.rabbit_hunts+d.other_expenses)
FROM display d WHERE n.id=d.notification_id AND n.user_id=d.owner_id
 AND n.type='diamond_spin_settlement' AND n.data->>'day'=d.day::text
 AND COALESCE((n.data->>'statement_version')::integer,1)<2;
DO $proof$
BEGIN
 IF md5(pg_get_functiondef('public.fn_diamond_spin_settle_day(uuid,date)'::regprocedure)) IS DISTINCT FROM 'c6170e30922484b15fe0b53376b8099d'
  OR md5(pg_get_functiondef('public.fn_diamond_spin_chip_payouts(uuid,date)'::regprocedure)) IS DISTINCT FROM 'a1bde2422bc0e840c64f3c3e88547498'
  OR md5(pg_get_functiondef('public.fn_diamond_spin_statement_message(date,bigint,numeric,bigint,bigint,bigint,integer,bigint,bigint)'::regprocedure)) IS DISTINCT FROM '34115edda647f0bd1a611727fc5b9e40' THEN
  RAISE EXCEPTION 'diamond_statement_postimage_required'; END IF;
END $proof$;
COMMIT;
