-- AFTER migration 20260921202834 on the legacy database: the day settled under
-- the pre-burn contract is untouched (no retroactive burn, owner keeps the full
-- 100, replay returns the legacy figures), the day that was open takes the
-- defaults, and once that day settles it burns at the current rate.
BEGIN;
SET LOCAL "request.jwt.claims"='{"role":"service_role"}';
DO $$
DECLARE owner constant uuid:='d1000000-0000-4000-8000-000000000002';
 d date:=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
 legacy public.diamond_spin_days; opened public.diamond_spin_days; replay jsonb; result jsonb; supply numeric;
BEGIN
 SELECT * INTO legacy FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-1;
 SELECT * INTO opened FROM public.diamond_spin_days WHERE owner_id=owner AND day=d-2;
 replay:=public.fn_diamond_spin_settle_day(owner,d-1);
 IF ROW(legacy.status,legacy.settled_net,legacy.profit_burn_bps,legacy.profit_burn,legacy.credited_net)
    IS DISTINCT FROM ROW('settled'::text,100::bigint,0,0::bigint,100::bigint)
  OR ROW(opened.status,opened.pending_diamonds,opened.profit_burn_bps,opened.profit_burn,opened.credited_net)
    IS DISTINCT FROM ROW('open'::text,100::bigint,0,0::bigint,NULL::bigint)
  OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>100100
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=owner AND amount=100)<>1
  OR EXISTS(SELECT 1 FROM public.ca_mint_ledger WHERE op_id LIKE 'diamond-spin-burn:%')
  OR replay->>'replayed' IS DISTINCT FROM 'true' OR (replay->>'net_diamonds')::int<>100
  OR (replay->>'profit_burn')::int<>0 OR (replay->>'credited_net')::int<>100 THEN
  RAISE EXCEPTION 'The pre-burn settled day or the open day was rewritten by the migration: % / %',to_jsonb(legacy),to_jsonb(opened);
 END IF;
 supply:=public.fn_ca_mint_supply('diamonds');
 result:=public.fn_diamond_spin_settle_day(owner,d-2);
 SET CONSTRAINTS ALL IMMEDIATE;
 IF (result->>'net_diamonds')::int<>100 OR (result->>'profit_burn')::int<>20 OR (result->>'credited_net')::int<>80
  OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>100180
  OR public.fn_ca_mint_supply('diamonds')<>supply-20
  OR (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id='diamond-spin-burn:'||owner||':'||(d-2) AND action='burn' AND amount=20 AND holder_type='player' AND holder_id=owner)<>1
  OR (SELECT count(*) FROM public.push_outbox WHERE recipient_user_id=owner)<>1 THEN
  RAISE EXCEPTION 'The day that was open at installation did not settle with the burn: %',result;
 END IF;
 RAISE NOTICE 'PASS Daily burn installation: the pre-burn settled day keeps its full 100 and its replay, the open day took the defaults, and its later settlement burned 20 and credited 80 with no new push';
END $$;
COMMIT;
