-- This local-only late failure reuses the public purchase owner and original
-- accepted-zero fixture. No substitute money or seating function is installed.
BEGIN;
CREATE FUNCTION pg_temp.original_paid_reject_final_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.idempotency_key LIKE '%:tok:original-paid-final-failure' AND OLD.response IS NULL AND NEW.response IS NOT NULL THEN
  IF NEW.response->>'success' IS DISTINCT FROM 'true' OR NEW.response->>'seated' IS DISTINCT FROM 'true'
  OR NOT EXISTS(SELECT 1 FROM public.table_seats WHERE id=(NEW.response->>'seat_id')::uuid
    AND user_id='b7100000-0000-4000-8000-000000000007' AND stack=100 AND left_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM public.wallet_transactions WHERE user_id='b7100000-0000-4000-8000-000000000007'
    AND related_entity_id='b7200000-0000-4000-8000-000000000004' AND category='rebuy' AND type='debit' AND amount=1)
  OR NOT EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE id='b7800000-0000-4000-8000-000000000004' AND state='rebought')
  THEN RAISE EXCEPTION 'NATIVE_PAID_PURCHASE_DID_NOT_REACH_FINAL_STATE'; END IF;
  RAISE EXCEPTION 'NATIVE_PAID_PURCHASE_FINAL_FAILURE_PROVEN' USING ERRCODE='ZX928';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_original_paid_final_failure BEFORE UPDATE OF response ON public.entry_purchase_idempotency_receipts
 FOR EACH ROW EXECUTE FUNCTION pg_temp.original_paid_reject_final_receipt();
SELECT public.process_tournament_rebuy('b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000007','rebuy',1,100,1,'original-paid-final-failure');
COMMIT;
