DO $$
DECLARE d public.diamond_spin_days;
BEGIN
 SELECT * INTO d FROM public.diamond_spin_days WHERE owner_id='d1000000-0000-4000-8000-000000000002'
  AND day=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date-1;
 IF d.status IS DISTINCT FROM 'settled' OR d.settled_net<>100 OR d.pending_diamonds<>0
  OR (SELECT diamonds FROM public.profiles WHERE id=d.owner_id)<>100100
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=d.owner_id)<>1
  OR (SELECT count(*) FROM public.notifications WHERE user_id=d.owner_id AND type='diamond_spin_settlement')<>1
  OR (SELECT count(*) FROM public.push_outbox WHERE recipient_user_id=d.owner_id AND event='diamond_spin_settlement')<>1
  OR (SELECT count(*) FROM public.diamond_spin_movements WHERE owner_id=d.owner_id)<>1
  OR public.fn_ca_arena_diamonds()<>0 THEN
  RAISE EXCEPTION 'Concurrent Settlement Produced Missing Or Duplicate Money/Delivery';
 END IF;
 RAISE NOTICE 'PASS Daily Diamond concurrent settlement: observed owner-row blocking, one committed wallet transfer, statement, notification and outbox';
END $$;
