-- Original seat restoration proof, connected to the same fully qualified original hand.
CREATE OR REPLACE FUNCTION smarter_private.original_paired_seat_restoration_proof(f jsonb,tp jsonb,lo timestamptz,hi timestamptz)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog SET timezone='UTC' AS $proof$
DECLARE ready jsonb;b jsonb;p jsonb;a jsonb;q jsonb;
BEGIN
 ready:=smarter_private.original_retirement_boundary_proof(tp,lo,hi);
 IF ready->'ready' IS DISTINCT FROM 'true'::jsonb THEN RETURN jsonb_build_object('status','blocked','reason','original_hand_refused');END IF;
 b:=f#>'{next,before_row}';p:=f#>'{prior,after_row}';a:=f#>'{next,after_row}';q:=f#>'{qualification,row}';
 IF f IS NULL OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
 OR b-'left_at' IS DISTINCT FROM p-'left_at' OR p->'left_at' IS DISTINCT FROM 'null'::jsonb
 OR a-'left_at'-'occupancy_id' IS DISTINCT FROM b-'left_at'-'occupancy_id'
 OR a->'left_at' IS DISTINCT FROM 'null'::jsonb OR a->>'occupancy_id' IS NULL
 OR a->>'occupancy_id'=b->>'occupancy_id'
 OR f#>>'{next,transaction_id}' IS DISTINCT FROM tp#>>'{restoration,transaction_id}'
 OR f->'qualification' IS DISTINCT FROM tp->'qualification'
 OR b->>'id' IS DISTINCT FROM q#>>'{seat,id}' OR b->>'user_id' IS DISTINCT FROM q->>'user_id'
 OR b->>'table_id' IS DISTINCT FROM tp#>>'{qualification,table_id}'
 OR b->>'left_at' IS DISTINCT FROM q#>>'{seat,left_at}'
 OR (b->>'stack')::numeric IS DISTINCT FROM (q#>>'{stack,stack_before}')::numeric
 OR (b->>'joined_at')::timestamptz IS DISTINCT FROM (q#>>'{seat,joined_at}')::timestamptz
 OR b->>'occupancy_id' IS DISTINCT FROM q#>>'{seat,occupancy_id}'
 OR (f#>>'{prior,event_id}')::bigint >= (f#>>'{next,event_id}')::bigint
 OR lo>=(b->>'left_at')::timestamptz OR hi<=(f#>>'{next,observed_at}')::timestamptz
 THEN RETURN jsonb_build_object('status','blocked','reason','exact_original_seat_or_interval_refused');END IF;
 RETURN jsonb_build_object('status','ready','financial_admission',false,'source_name','table_seats','event_id',f#>'{next,event_id}',
 'original_monetary_stack_unchanged',true,'signed_original_hand_preserved',true,'raw_history_rewritten',false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
 RETURN jsonb_build_object('status','blocked','reason','malformed_original');
END $proof$;
