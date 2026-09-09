BEGIN;
DO $legacy$
DECLARE r jsonb; rejected boolean:=false;
BEGIN
 r:=public.fn_ca_unregister_tournament_player_exact(
  'c3000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',NULL,'old receipt after correction','c8000000-0000-4000-8000-000000000001');
 IF (r->>'replayed')::boolean IS DISTINCT FROM true
    OR (r->>'refunded_chips')::numeric IS DISTINCT FROM 0
    OR (r->>'returned_ticket_value')::numeric IS DISTINCT FROM 200 THEN
  RAISE EXCEPTION 'historical receipt changed: %',r;
 END IF;
 BEGIN
  PERFORM public.fn_settle_tournament_refund_exact(
   'c3000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001',
   200,180,0,20,'fn_unregister_from_tournament','value already returned as ticket');
 EXCEPTION WHEN SQLSTATE 'P0404' THEN rejected:=true;
 END;
 IF NOT rejected OR (SELECT chip_balance FROM public.club_members)<>100
    OR (SELECT count(*) FROM public.tournament_tickets)<>1
    OR EXISTS(SELECT 1 FROM public.wallet_transactions)
    OR EXISTS(SELECT 1 FROM public.tournament_refund_tranches) THEN
  RAISE EXCEPTION 'old ticket value was credited again';
 END IF;
 RAISE NOTICE 'PASS historical ticket receipt survives migration, issued value cannot be paid again';
END;
$legacy$;
ROLLBACK;
