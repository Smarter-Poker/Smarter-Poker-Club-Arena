-- Candidate finite original-player boundary proof, no raw inventory mutation.
CREATE OR REPLACE FUNCTION smarter_private.original_closed_player_proof(f jsonb,lo timestamptz,hi timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $proof$
DECLARE e jsonb;prior jsonb;b jsonb;t jsonb;c jsonb;refund jsonb;ledger jsonb;wallet jsonb;fund jsonb;
 owner uuid;term jsonb;entry_ledger jsonb;
BEGIN
 e:=f->'event';prior:=f->'prior';b:=e->'before_row';t:=f#>'{parent,after_row}';
 IF f IS NULL OR lo IS NULL OR hi IS NULL OR jsonb_typeof(b) IS DISTINCT FROM 'object'
 OR e->>'source_name' IS DISTINCT FROM 'tournament_players'
 OR jsonb_typeof(prior->'after_row') IS DISTINCT FROM 'object'
 OR b-ARRAY['status','eliminated_at'] IS DISTINCT FROM (prior->'after_row')-ARRAY['status','eliminated_at']
 OR b->>'status' IS DISTINCT FROM 'eliminated' OR b->>'eliminated_at' IS NULL
 OR (b->>'eliminated_at')::timestamptz NOT BETWEEN '2026-10-06 15:33:00Z' AND '2026-10-06 15:33:10Z'
 OR (prior->>'event_id')::bigint >= (e->>'event_id')::bigint
 OR lo >= (b->>'eliminated_at')::timestamptz OR hi <= (e->>'observed_at')::timestamptz
 OR f#>>'{parent,source_name}' IS DISTINCT FROM 'tournaments'
 OR f#>>'{parent,row_id}' IS DISTINCT FROM b->>'tournament_id' OR t->>'id' IS DISTINCT FROM b->>'tournament_id'
 OR f#>>'{parent,observed_at}' IS NULL OR (f#>>'{parent,observed_at}')::timestamptz>=hi
 OR t->>'status' NOT IN('COMPLETED','CANCELLED') OR t->>'status' IS NULL
 THEN RETURN jsonb_build_object('status','blocked','reason','original_closed_interval_or_value_refused');END IF;
 IF t->>'status'='COMPLETED' THEN
  term:=smarter_private.original_closed_tournament_rails_proof(f->'terminal_fixture',hi);
  IF term->>'status' IS DISTINCT FROM 'ready' OR term->>'tournament_id' IS DISTINCT FROM b->>'tournament_id'
  THEN RETURN jsonb_build_object('status','blocked','reason','original_terminal_rails_refused');END IF;
  IF b->>'source_satellite_id' IS NOT NULL THEN
   owner:=public.fn_union_pnl_satellite_seat_owner((b->>'id')::uuid,(b->>'tournament_id')::uuid);
  ELSE
   IF jsonb_typeof(f->'entry_funding') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'entry_funding')<>1 THEN
    RETURN jsonb_build_object('status','blocked','reason','original_entry_missing');END IF;
   fund:=f#>'{entry_funding,0,receipt}';ledger:=f#>'{entry_funding,0,ledger}';
   IF fund->>'registration_id' IS DISTINCT FROM b->>'id' OR fund->>'user_id' IS DISTINCT FROM b->>'user_id'
   OR fund->>'tournament_id' IS DISTINCT FROM b->>'tournament_id' OR fund->>'asset' IS DISTINCT FROM 'chips'
   OR (fund->>'amount')::numeric IS NULL OR (fund->>'amount')::numeric<=0
   OR fund->>'ledger_id' IS DISTINCT FROM ledger->>'id' OR ledger->>'status' IS DISTINCT FROM 'posted'
   OR ledger->>'row_hash' IS NULL OR ledger->>'from_type' IS DISTINCT FROM 'player_wallet'
   OR ledger->>'from_entity_id' IS DISTINCT FROM b->>'user_id' OR ledger->>'to_type' IS DISTINCT FROM 'prize_liability'
   OR ledger->>'to_entity_id' IS DISTINCT FROM b->>'tournament_id' OR ledger->>'club_id' IS DISTINCT FROM fund->>'funding_club_id'
   OR (ledger->>'amount')::numeric IS DISTINCT FROM (fund->>'amount')::numeric THEN
    RETURN jsonb_build_object('status','blocked','reason','original_entry_debit_refused');END IF;
   owner:=(fund->>'funding_club_id')::uuid;
  END IF;
  IF owner IS NULL THEN RETURN jsonb_build_object('status','blocked','reason','original_entry_owner_unproven');END IF;
 ELSE
  c:=f->'cancellation';
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->>'tournament_id' IS DISTINCT FROM b->>'tournament_id'
  OR c->'receipt_version' NOT IN('2'::jsonb,'3'::jsonb) OR c->>'receipt_version' IS NULL
  OR c#>'{receipt,ok}' IS DISTINCT FROM 'true'::jsonb OR c#>'{receipt,fully_settled}' IS DISTINCT FROM 'true'::jsonb
  OR c->>'settled_at' IS NULL OR c->>'escrow_closed_at' IS NULL
  OR (c->>'settled_at')::timestamptz>=hi OR (c->>'escrow_closed_at')::timestamptz>=hi
  OR NOT(c->'refunded_registration_ids' ? (b->>'id')) THEN
   RETURN jsonb_build_object('status','blocked','reason','original_cancellation_refused');END IF;
  IF jsonb_typeof(f->'entry_funding') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'entry_funding')<>1 THEN
   RETURN jsonb_build_object('status','blocked','reason','original_cancelled_entry_missing');END IF;
  fund:=f#>'{entry_funding,0,receipt}';entry_ledger:=f#>'{entry_funding,0,ledger}';
  IF fund->>'registration_id' IS DISTINCT FROM b->>'id' OR fund->>'user_id' IS DISTINCT FROM b->>'user_id'
  OR fund->>'tournament_id' IS DISTINCT FROM b->>'tournament_id' OR fund->>'asset' IS DISTINCT FROM 'chips'
  OR (fund->>'amount')::numeric IS NULL OR (fund->>'amount')::numeric<=0
  OR fund->>'ledger_id' IS DISTINCT FROM entry_ledger->>'id' OR entry_ledger->>'status' IS DISTINCT FROM 'posted'
  OR entry_ledger->>'row_hash' IS NULL OR entry_ledger->>'from_type' IS DISTINCT FROM 'player_wallet'
  OR entry_ledger->>'from_entity_id' IS DISTINCT FROM b->>'user_id' OR entry_ledger->>'to_type' IS DISTINCT FROM 'prize_liability'
  OR entry_ledger->>'to_entity_id' IS DISTINCT FROM b->>'tournament_id'
  OR entry_ledger->>'club_id' IS DISTINCT FROM fund->>'funding_club_id'
  OR (entry_ledger->>'amount')::numeric IS DISTINCT FROM (fund->>'amount')::numeric THEN
   RETURN jsonb_build_object('status','blocked','reason','original_cancelled_entry_debit_refused');END IF;
  SELECT r INTO refund FROM jsonb_array_elements(c#>'{receipt,refunds}') r WHERE r->>'registration_id'=b->>'id';
  ledger:=f->'refund_ledger';wallet:=f->'refund_wallet';
  IF refund IS NULL OR (SELECT count(*) FROM jsonb_array_elements(c#>'{receipt,refunds}')r WHERE r->>'registration_id'=b->>'id')<>1
  OR refund->>'user_id' IS DISTINCT FROM b->>'user_id' OR refund->>'credit_ledger_id' IS DISTINCT FROM ledger->>'id'
  OR refund->>'source_wallet_club_id' IS DISTINCT FROM fund->>'funding_club_id'
  OR refund->>'entitlement_id' IS DISTINCT FROM fund->>'entitlement_id'
  OR (refund->>'gross_paid')::numeric IS DISTINCT FROM (fund->>'amount')::numeric
  OR refund->>'wallet_transaction_id' IS DISTINCT FROM wallet->>'id'
  OR ledger->>'status' IS DISTINCT FROM 'posted' OR ledger->>'row_hash' IS NULL
  OR ledger->>'to_type' IS DISTINCT FROM 'player_wallet' OR ledger->>'to_entity_id' IS DISTINCT FROM b->>'user_id'
  OR ledger->>'club_id' IS DISTINCT FROM refund->>'source_wallet_club_id'
  OR (ledger->>'amount')::numeric IS DISTINCT FROM (refund->>'amount_paid_now')::numeric
  OR (wallet->>'amount')::numeric IS DISTINCT FROM (refund->>'amount_paid_now')::numeric
  OR wallet->>'user_id' IS DISTINCT FROM b->>'user_id' OR wallet->>'type' IS DISTINCT FROM 'credit'
  OR (refund->>'amount_paid_before')::numeric IS DISTINCT FROM 0
  OR (refund->>'amount_paid_now')::numeric IS DISTINCT FROM (refund->>'gross_paid')::numeric
  THEN RETURN jsonb_build_object('status','blocked','reason','original_refund_delivery_refused');END IF;
  owner:=(refund->>'source_wallet_club_id')::uuid;
 END IF;
 RETURN jsonb_build_object('status','ready','financial_admission',false,'event_id',e->'event_id','source_name','tournament_players',
 'original_owner',owner,'original_closed_held',0,'original_state_hashes_preserved',true,'missing_force_event_invented',false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
 RETURN jsonb_build_object('status','blocked','reason','malformed_original');
END $proof$;
