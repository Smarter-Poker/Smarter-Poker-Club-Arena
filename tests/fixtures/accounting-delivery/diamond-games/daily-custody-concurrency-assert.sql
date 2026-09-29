-- Owner ruling 2026-09-21 (R14, R17; migration 20260921202834): the settled net
-- of 100 burns 20 in exactly one register row and credits 80 in exactly one
-- wallet transfer; the daily statement notification exists once and produces
-- NO push_outbox row. Before that ruling this file required the full 100 credited
-- and exactly one push_outbox row (20260919152614).
DO $$
DECLARE d public.diamond_spin_days;
BEGIN
 SELECT * INTO d FROM public.diamond_spin_days WHERE owner_id='d1000000-0000-4000-8000-000000000002'
  AND day=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date-1;
 IF d.status IS DISTINCT FROM 'settled' OR d.settled_net<>100 OR d.pending_diamonds<>0
  OR d.profit_burn_bps<>public.fn_diamond_spin_profit_burn_bps() OR d.profit_burn<>20 OR d.credited_net<>80
  OR (SELECT diamonds FROM public.profiles WHERE id=d.owner_id)<>100080
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=d.owner_id)<>1
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=d.owner_id AND amount=80 AND id=d.wallet_transaction_id)<>1
  OR (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id='diamond-spin-burn:'||d.owner_id||':'||d.day AND action='burn' AND asset='diamonds' AND holder_type='player' AND holder_id=d.owner_id AND amount=20)<>1
  OR (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id LIKE 'diamond-spin-burn:%')<>1
  OR (SELECT count(*) FROM public.notifications WHERE user_id=d.owner_id AND type='diamond_spin_settlement')<>1
  OR (SELECT count(*) FROM public.notifications WHERE id=d.notification_id AND data->>'_push'='ledger_only' AND (data->>'profit_burn')::int=20 AND (data->>'credited_net')::int=80)<>1
  OR (SELECT count(*) FROM public.push_outbox WHERE recipient_user_id=d.owner_id)<>0
  OR (SELECT count(*) FROM public.diamond_spin_movements WHERE owner_id=d.owner_id)<>1
  OR public.fn_ca_arena_diamonds()<>0 THEN
  RAISE EXCEPTION 'Concurrent Settlement Produced Missing Or Duplicate Money/Burn/Delivery: %',to_jsonb(d);
 END IF;
 RAISE NOTICE 'PASS Daily Diamond concurrent settlement: observed owner-row blocking, one committed wallet transfer of 80, one register burn of 20, statement, one quiet notification and no push';
END $$;
