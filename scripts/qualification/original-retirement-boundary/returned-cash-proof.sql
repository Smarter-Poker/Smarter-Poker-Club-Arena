-- Reproof of exact already-issued original cash restitution, no new payment.
CREATE OR REPLACE FUNCTION smarter_private.original_returned_cash_base_proof(f jsonb,lo timestamptz,hi timestamptz)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog SET timezone='UTC' AS $proof$
DECLARE e jsonb;p jsonb;b jsonb;x jsonb;s jsonb;l jsonb;m jsonb;w jsonb;native jsonb;uid text;club text;base numeric;
BEGIN
 e:=f->'event';p:=f->'prior';b:=e->'before_row';x:=f->'original_participant';s:=x->'stack';
 l:=f->'base_ledger';m:=f->'base_mint';w:=f->'base_idempotency';native:=f->'native';
 IF f IS NULL OR lo IS NULL OR hi IS NULL OR jsonb_typeof(b) IS DISTINCT FROM 'object'
 OR e->>'source_name' IS DISTINCT FROM 'table_seats' OR e->>'operation' NOT IN('UPDATE','DELETE') OR e->>'operation' IS NULL
 OR jsonb_typeof(p->'after_row') IS DISTINCT FROM 'object' OR b-'left_at' IS DISTINCT FROM (p->'after_row')-'left_at'
 OR p#>'{after_row,left_at}' IS DISTINCT FROM 'null'::jsonb OR b->>'left_at' IS NULL
 OR (b->>'left_at')::timestamptz NOT BETWEEN '2026-10-06 15:33:00Z' AND '2026-10-06 15:33:10Z'
 OR (p->>'event_id')::bigint >= (e->>'event_id')::bigint
 OR lo>=(b->>'left_at')::timestamptz OR hi<=(e->>'observed_at')::timestamptz
 OR b->>'id' IS DISTINCT FROM s->>'seat_id' OR b->>'user_id' IS DISTINCT FROM s->>'user_id'
 OR b->>'occupancy_id' IS DISTINCT FROM s->>'occupancy_id'
 OR (b->>'joined_at')::timestamptz IS DISTINCT FROM (s->>'seat_joined_at')::timestamptz
 OR jsonb_typeof(b->'stack') IS DISTINCT FROM 'number' OR jsonb_typeof(s->'stack_before') IS DISTINCT FROM 'number'
 OR (b->>'stack')::numeric IS DISTINCT FROM (s->>'stack_before')::numeric OR (b->>'stack')::numeric<=0
 OR x#>'{manifest_participant,funding_lineage,issues}' IS DISTINCT FROM '[]'::jsonb
 OR jsonb_typeof(x#>'{manifest_participant,funding_receipts}') IS DISTINCT FROM 'array'
 OR jsonb_array_length(x#>'{manifest_participant,funding_receipts}')=0
 OR native#>>'{stack_result,success}' IS DISTINCT FROM 'true'
 OR native#>>'{stack_result,conservation_checked}' IS DISTINCT FROM 'true'
 OR native#>>'{post_commit_result,ok}' IS DISTINCT FROM 'true'
 OR native->>'post_commit_completed_at' IS NULL OR (native->>'post_commit_completed_at')::timestamptz>=hi
 OR native#>>'{stack_result,table_id}' IS DISTINCT FROM b->>'table_id'
 OR NOT EXISTS(SELECT FROM jsonb_array_elements(native#>'{stack_result,request,stacks}') ns
  WHERE ns->>'seat_id'=s->>'seat_id' AND ns->>'user_id'=s->>'user_id'
  AND (ns->>'stack_before')::numeric=(s->>'stack_before')::numeric AND (ns->>'stack')::numeric=(s->>'stack')::numeric
  AND (ns->>'seat_joined_at')::timestamptz=(s->>'seat_joined_at')::timestamptz)
 THEN RETURN jsonb_build_object('status','blocked','reason','original_returned_cash_identity_refused');END IF;
 uid:=s->>'user_id';club:=x->>'funding_club_id';base:=(s->>'stack_before')::numeric;
 IF f ? 'custody' AND (f#>>'{custody,state}' IS DISTINCT FROM 'consumed'
 OR f#>>'{custody,original_inventory_event}' IS DISTINCT FROM e->>'event_id'
 OR f#>>'{custody,user_id}' IS DISTINCT FROM uid OR f#>>'{custody,occupancy_id}' IS DISTINCT FROM s->>'occupancy_id'
 OR f#>>'{custody,funding_club_id}' IS DISTINCT FROM club OR f#>>'{custody,restore_key}' IS DISTINCT FROM f->>'restore_key'
 OR (f#>>'{custody,stack_before}')::numeric IS DISTINCT FROM base
 OR (f#>>'{custody,stack_after}')::numeric IS DISTINCT FROM (s->>'stack')::numeric
 OR f#>>'{custody,issuance_ledger}' IS DISTINCT FROM l->>'id') THEN
 RETURN jsonb_build_object('status','blocked','reason','original_consumed_custody_refused');END IF;
 IF club IS NULL OR f->>'restore_key' IS NULL OR l->>'idempotency_key' IS DISTINCT FROM f->>'restore_key'
 OR l->>'status' IS DISTINCT FROM 'posted' OR l->>'row_hash' IS NULL
 OR l->>'from_type' IS DISTINCT FROM 'issuance_reserve' OR l->>'to_type' IS DISTINCT FROM 'player_wallet'
 OR l->>'to_entity_id' IS DISTINCT FROM uid OR l->>'club_id' IS DISTINCT FROM club OR l->>'category' IS DISTINCT FROM 'refund'
 OR (l->>'amount')::numeric IS DISTINCT FROM base OR l->>'created_at' IS NULL
 OR (l->>'created_at')::timestamptz<=(b->>'left_at')::timestamptz OR (l->>'created_at')::timestamptz>=hi
 OR m->>'op_id' IS DISTINCT FROM f->>'restore_key' OR m->>'chip_ledger_id' IS DISTINCT FROM l->>'id'
 OR m->>'action' IS DISTINCT FROM 'mint' OR m->>'asset' IS DISTINCT FROM 'chips'
 OR m->>'holder_type' IS DISTINCT FROM 'player' OR m->>'holder_id' IS DISTINCT FROM uid
 OR (m->>'amount')::numeric IS DISTINCT FROM base
 OR w->>'key' IS DISTINCT FROM f->>'restore_key' OR w->>'user_id' IS DISTINCT FROM uid
 OR (w->>'amount')::numeric IS DISTINCT FROM base
 THEN RETURN jsonb_build_object('status','blocked','reason','original_returned_cash_receipts_refused');END IF;
 RETURN jsonb_build_object('status','ready','financial_admission',false,'event_id',e->'event_id',
 'original_base_returned',base,'original_owner',club,'original_user',uid,'new_payment',false,
 'preserved_signed_delta',(s->>'stack')::numeric-base,'original_closed_held',0,'raw_history_rewritten',false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
 RETURN jsonb_build_object('status','blocked','reason','malformed_original');
END $proof$;
