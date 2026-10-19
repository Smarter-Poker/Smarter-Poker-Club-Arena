CREATE OR REPLACE FUNCTION public.fn_ca_legacy_round3_wallet_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_period record; v_legacy numeric;
BEGIN
 IF NEW.category='rakeback' AND NEW.description='Round 3: agent -> player rakeback [club wallet]' THEN
  IF NEW.related_entity_id IS NULL OR NOT EXISTS(SELECT 1 FROM rakeback_period_payouts p
   JOIN rakeback_periods rp ON rp.id=p.rakeback_period_id
   WHERE p.id=NEW.related_entity_id AND p.user_id=NEW.user_id AND p.club_id=rp.club_id AND p.user_id=rp.user_id
    AND p.payout_amount=NEW.amount AND p.status='paid' AND p.wallet_transaction_id IS NULL AND rp.status='pending')
  THEN RAISE EXCEPTION 'Round3 requires the unique unpaid period receipt' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.category='rakeback' AND NEW.related_entity_id IS NOT NULL THEN
  SELECT rp.*,receipt.payout_amount AS receipt_amount,receipt.user_id AS receipt_user INTO v_period
  FROM rakeback_period_payouts receipt JOIN rakeback_periods rp ON rp.id=receipt.rakeback_period_id
  WHERE receipt.id=NEW.related_entity_id;
  IF FOUND AND (v_period.period_end+1)::timestamp AT TIME ZONE 'UTC' > statement_timestamp() THEN
   RAISE EXCEPTION 'Legacy period payment requires a closed earning period' USING ERRCODE='55000';
  END IF;

 END IF;
 RETURN NEW;
END $function$
