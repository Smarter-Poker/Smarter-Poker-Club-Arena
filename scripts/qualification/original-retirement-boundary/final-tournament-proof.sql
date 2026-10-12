-- Exact original terminal and payout rails. Pure evidence proof; no admission/payment.
CREATE OR REPLACE FUNCTION smarter_private.original_closed_tournament_rails_proof(f jsonb,hi timestamptz)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog SET timezone='UTC' AS $proof$
DECLARE terminal jsonb;pay jsonb;credit jsonb;ledger jsonb;amount numeric;total numeric:=0;n integer:=0;
BEGIN
 terminal:=f->'terminal';
 IF f IS NULL OR hi IS NULL OR jsonb_typeof(terminal) IS DISTINCT FROM 'object'
 OR terminal->'receipt_version' NOT IN('2'::jsonb,'3'::jsonb)
 OR terminal->>'receipt_version' IS NULL OR terminal->>'tournament_id' IS DISTINCT FROM f->>'tournament_id'
 OR terminal->>'accounting_state' IS DISTINCT FROM 'recognized'
 OR terminal#>'{cash_receipt,fully_settled}' IS DISTINCT FROM 'true'::jsonb
 OR terminal#>'{cash_receipt,ok}' IS DISTINCT FROM 'true'::jsonb
 OR terminal->>'completed_at' IS NULL OR terminal->>'settled_at' IS NULL OR terminal->>'escrow_closed_at' IS NULL
 OR (terminal->>'completed_at')::timestamptz>=hi OR (terminal->>'settled_at')::timestamptz>=hi
 OR (terminal->>'escrow_closed_at')::timestamptz>=hi
 OR jsonb_typeof(f->'payouts') IS DISTINCT FROM 'array' OR jsonb_typeof(f->'credits') IS DISTINCT FROM 'array'
 OR jsonb_typeof(f->'ledgers') IS DISTINCT FROM 'array'
 OR jsonb_array_length(f->'payouts') IS DISTINCT FROM (terminal->>'cash_payout_count')::integer
 OR jsonb_array_length(f->'payouts') IS DISTINCT FROM jsonb_array_length(f->'credits')
 OR jsonb_array_length(f->'payouts') IS DISTINCT FROM jsonb_array_length(f->'ledgers')
 OR f->'diamond_rail_count' IS DISTINCT FROM '0'::jsonb OR f->'satellite_rail_count' IS DISTINCT FROM '0'::jsonb
 OR (terminal->>'cash_payout_total')::numeric IS DISTINCT FROM (terminal->>'prize_pool')::numeric
 OR (terminal->>'bounty_payout_total')::numeric IS DISTINCT FROM (terminal->>'bounty_pool')::numeric
 OR (terminal->>'bounty_pool')::numeric IS DISTINCT FROM 0
 THEN RETURN jsonb_build_object('status','blocked','reason','original_terminal_or_asset_refused');END IF;
 FOR pay IN SELECT value FROM jsonb_array_elements(f->'payouts') LOOP
  amount:=(pay->>'amount')::numeric;
  IF amount IS NULL OR amount<=0 OR amount*100<>trunc(amount*100)
  OR pay->>'tournament_id' IS DISTINCT FROM f->>'tournament_id'
  OR pay->>'paid_at' IS NULL OR (pay->>'paid_at')::timestamptz>=hi
  OR NOT EXISTS(SELECT FROM jsonb_array_elements(terminal#>'{cash_receipt,payouts}') p
   WHERE p->>'user_id'=pay->>'user_id' AND (p->>'amount')::numeric=amount)
  THEN RETURN jsonb_build_object('status','blocked','reason','original_payout_refused');END IF;
  SELECT c INTO credit FROM jsonb_array_elements(f->'credits') c
  WHERE c->>'user_id'=pay->>'user_id' AND c->>'tournament_id'=f->>'tournament_id' AND (c->>'amount')::numeric=amount;
  IF credit IS NULL OR (SELECT count(*) FROM jsonb_array_elements(f->'credits') c
   WHERE c->>'user_id'=pay->>'user_id' AND c->>'tournament_id'=f->>'tournament_id' AND (c->>'amount')::numeric=amount)<>1
  THEN RETURN jsonb_build_object('status','blocked','reason','original_credit_ambiguous');END IF;
  SELECT l INTO ledger FROM jsonb_array_elements(f->'ledgers')l WHERE l->>'id'=credit->>'ledger_id';
  IF ledger IS NULL OR ledger->>'status' IS DISTINCT FROM 'posted' OR ledger->>'row_hash' IS NULL
  OR ledger->>'from_type' IS DISTINCT FROM 'prize_liability' OR ledger->>'from_entity_id' IS DISTINCT FROM f->>'tournament_id'
  OR ledger->>'to_type' IS DISTINCT FROM 'player_wallet' OR ledger->>'to_entity_id' IS DISTINCT FROM pay->>'user_id'
  OR ledger->>'category' IS DISTINCT FROM 'tournament_prize' OR (ledger->>'amount')::numeric IS DISTINCT FROM amount
  OR ledger->>'club_id' IS DISTINCT FROM credit->>'credited_club_id'
  OR ledger->>'created_at' IS NULL OR (ledger->>'created_at')::timestamptz>=hi
  THEN RETURN jsonb_build_object('status','blocked','reason','original_posted_prize_refused');END IF;
  total:=total+amount;n:=n+1;
 END LOOP;
 IF total IS DISTINCT FROM (terminal->>'cash_payout_total')::numeric THEN
 RETURN jsonb_build_object('status','blocked','reason','original_pool_not_conserved');END IF;
 RETURN jsonb_build_object('status','ready','financial_admission',false,'tournament_id',f->'tournament_id',
 'original_prize_rows',n,'original_pool',total,'all_actual_rails_checked',true,'raw_history_rewritten',false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
 RETURN jsonb_build_object('status','blocked','reason','malformed_original');
END $proof$;
