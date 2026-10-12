-- Isolated candidate original-economic proof. No money writes or production use.
CREATE OR REPLACE FUNCTION smarter_private.original_erased_cash_base_proof(f jsonb,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog SET timezone='UTC' AS $proof$
DECLARE e jsonb;prior jsonb;s jsonb;mp jsonb;delta numeric;base numeric;fund jsonb;clubs text[];a jsonb;
BEGIN
 IF f IS NULL OR jsonb_typeof(f) IS DISTINCT FROM 'object' OR p_at IS NULL THEN RETURN jsonb_build_object('status','blocked','reason','missing_original');END IF;
 e:=f->'event';prior:=f->'prior';s:=f->'signed';mp:=f->'participant';a:=f->'atomic';
 IF e->>'source_name' IS DISTINCT FROM 'table_seats' OR e->>'operation' IS DISTINCT FROM 'DELETE'
 OR e->'after_row' IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(e->'before_row') IS DISTINCT FROM 'object'
 OR jsonb_typeof(prior->'after_row') IS DISTINCT FROM 'object'
 OR (e->'before_row')-'left_at' IS DISTINCT FROM (prior->'after_row')-'left_at'
 OR prior#>'{after_row,left_at}' IS DISTINCT FROM 'null'::jsonb
 OR e#>>'{before_row,left_at}' IS NULL
 OR (e#>>'{before_row,left_at}')::timestamptz NOT BETWEEN '2026-10-06 15:33:00Z' AND '2026-10-06 15:33:10Z'
 OR (prior->>'event_id')::bigint >= (e->>'event_id')::bigint
 OR p_at <= (e->>'observed_at')::timestamptz
 THEN RETURN jsonb_build_object('status','blocked','reason','original_transition_or_boundary_refused');END IF;
 IF s->>'seat_id' IS DISTINCT FROM e->>'row_id' OR s->>'seat_id' IS DISTINCT FROM e#>>'{before_row,id}'
 OR s->>'user_id' IS DISTINCT FROM e#>>'{before_row,user_id}'
 OR s->>'occupancy_id' IS DISTINCT FROM e#>>'{before_row,occupancy_id}'
 OR (s->>'seat_joined_at')::timestamptz IS DISTINCT FROM (e#>>'{before_row,joined_at}')::timestamptz
 OR jsonb_typeof(s->'stack_before') IS DISTINCT FROM 'number' OR jsonb_typeof(s->'stack') IS DISTINCT FROM 'number'
 OR jsonb_typeof(e#>'{before_row,stack}') IS DISTINCT FROM 'number'
 OR (s->>'stack_before')::numeric IS DISTINCT FROM (e#>>'{before_row,stack}')::numeric
 OR (s->>'stack_before')::numeric<=0 OR (s->>'stack')::numeric<0
 OR (s->>'stack_before')::numeric*100<>trunc((s->>'stack_before')::numeric*100)
 OR (s->>'stack')::numeric*100<>trunc((s->>'stack')::numeric*100)
 OR mp->>'seat_id' IS DISTINCT FROM s->>'seat_id' OR mp->>'user_id' IS DISTINCT FROM s->>'user_id'
 OR mp->>'occupancy_id' IS DISTINCT FROM s->>'occupancy_id'
 OR (mp->>'stack_before')::numeric IS DISTINCT FROM (s->>'stack_before')::numeric
 OR mp#>'{funding_lineage,issues}' IS DISTINCT FROM '[]'::jsonb
 OR jsonb_typeof(f->'funding') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'funding')=0
 OR jsonb_typeof(mp->'funding_receipts') IS DISTINCT FROM 'array'
 OR jsonb_array_length(mp->'funding_receipts') IS DISTINCT FROM jsonb_array_length(f->'funding')
 OR (SELECT count(DISTINCT x#>>'{receipt,id}') FROM jsonb_array_elements(f->'funding')x) IS DISTINCT FROM jsonb_array_length(f->'funding')
 OR EXISTS(SELECT FROM jsonb_array_elements(mp->'funding_receipts') r WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(f->'funding') x WHERE x#>>'{receipt,id}'=r->>'id'))
 THEN RETURN jsonb_build_object('status','blocked','reason','original_identity_stack_or_funding_refused');END IF;
 base:=(s->>'stack_before')::numeric;delta:=(s->>'stack')::numeric-base;
 IF a->>'table_id' IS DISTINCT FROM e#>>'{before_row,table_id}'
 OR a#>>'{stack_result,success}' IS DISTINCT FROM 'true'
 OR a#>>'{stack_result,conservation_checked}' IS DISTINCT FROM 'true'
 OR a#>>'{post_commit_result,ok}' IS DISTINCT FROM 'true' OR a->>'post_commit_completed_at' IS NULL
 OR (a->>'post_commit_completed_at')::timestamptz >= p_at
 OR NOT EXISTS(SELECT FROM jsonb_array_elements(a#>'{stack_result,departed}') d
 WHERE d->>'seat_id'=s->>'seat_id' AND d->>'user_id'=s->>'user_id' AND (d->>'delta')::numeric=delta)
 OR jsonb_typeof(f->'late_ledger') IS DISTINCT FROM 'object' OR f#>>'{late_ledger,idempotency_key}' IS DISTINCT FROM f->>'late_key'
 OR (f#>>'{late_ledger,amount}')::numeric IS DISTINCT FROM abs(delta)
 OR f#>>'{late_ledger,category}' IS DISTINCT FROM 'settlement'
 OR f->>'late_key' IS DISTINCT FROM 'late_seat_settle:'||(a#>>'{stack_result,hand_id}')||':'||(s->>'user_id')
 OR (CASE WHEN delta>0 THEN f#>>'{late_ledger,from_type}' IS DISTINCT FROM 'table_stack'
 OR f#>>'{late_ledger,from_entity_id}' IS DISTINCT FROM a->>'table_id'
 OR f#>>'{late_ledger,to_type}' IS DISTINCT FROM 'player_wallet' OR f#>>'{late_ledger,to_entity_id}' IS DISTINCT FROM s->>'user_id'
 ELSE f#>>'{late_ledger,from_type}' IS DISTINCT FROM 'player_wallet' OR f#>>'{late_ledger,from_entity_id}' IS DISTINCT FROM s->>'user_id'
 OR f#>>'{late_ledger,to_type}' IS DISTINCT FROM 'table_stack' OR f#>>'{late_ledger,to_entity_id}' IS DISTINCT FROM a->>'table_id' END)
 OR f#>>'{late_idempotency,user_id}' IS DISTINCT FROM s->>'user_id'
 OR (f#>>'{late_idempotency,amount}')::numeric IS DISTINCT FROM delta
 THEN RETURN jsonb_build_object('status','blocked','reason','completed_original_delta_refused');END IF;
 FOR fund IN SELECT value FROM jsonb_array_elements(f->'funding') LOOP
  IF fund#>>'{receipt,asset}' IS DISTINCT FROM 'chips' OR fund#>>'{receipt,account_type}' IS DISTINCT FROM 'player_wallet'
  OR fund#>>'{receipt,user_id}' IS DISTINCT FROM s->>'user_id' OR fund#>>'{receipt,account_entity_id}' IS DISTINCT FROM s->>'user_id'
  OR fund#>>'{receipt,table_id}' IS DISTINCT FROM a->>'table_id' OR fund#>>'{receipt,occupancy_id}' IS DISTINCT FROM s->>'occupancy_id'
  OR fund#>>'{receipt,source_ledger_id}' IS DISTINCT FROM fund#>>'{ledger,id}'
  OR fund#>>'{receipt,wallet_transaction_id}' IS DISTINCT FROM fund#>>'{debit,id}'
  OR fund#>>'{ledger,from_type}' IS DISTINCT FROM 'player_wallet' OR fund#>>'{ledger,from_entity_id}' IS DISTINCT FROM s->>'user_id'
  OR fund#>>'{debit,type}' IS DISTINCT FROM 'debit' OR fund#>>'{debit,user_id}' IS DISTINCT FROM s->>'user_id'
  OR (fund#>>'{receipt,amount}')::numeric IS NULL OR (fund#>>'{receipt,amount}')::numeric<=0
  OR (fund#>>'{receipt,amount}')::numeric IS DISTINCT FROM (fund#>>'{ledger,amount}')::numeric
  OR (fund#>>'{receipt,amount}')::numeric IS DISTINCT FROM (fund#>>'{debit,amount}')::numeric
  OR fund#>>'{receipt,funding_club_id}' IS DISTINCT FROM fund#>>'{ledger,club_id}'
  THEN RETURN jsonb_build_object('status','blocked','reason','original_debit_refused');END IF;
 END LOOP;
 SELECT array_agg(DISTINCT x#>>'{receipt,funding_club_id}') INTO clubs FROM jsonb_array_elements(f->'funding') x;
 IF cardinality(clubs) IS DISTINCT FROM 1 OR clubs[1] IS NULL OR f#>>'{late_ledger,club_id}' IS DISTINCT FROM clubs[1]
 THEN RETURN jsonb_build_object('status','blocked','reason','original_owner_refused');END IF;
 RETURN jsonb_build_object('status','ready','financial_admission',false,'boundary',p_at,'original_base',base,'preserved_played_delta',delta,
 'holding',jsonb_build_object('kind','original_erased_cash_receivable','source_id',s->>'occupancy_id','user_id',s->>'user_id','club_id',clubs[1],'amount',base),
 'raw_issue_event_id',e->'event_id','missing_force_event_invented',false,'current_membership_used',false);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
 RETURN jsonb_build_object('status','blocked','reason','malformed_original');
END $proof$;
