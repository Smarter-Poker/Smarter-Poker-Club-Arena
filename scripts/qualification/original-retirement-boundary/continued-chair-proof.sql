-- Exact original native restored chair tied to its paid original entry and final rails.
CREATE OR REPLACE FUNCTION smarter_private.original_continued_chair_proof(f jsonb,lo timestamptz,hi timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $proof$
DECLARE e jsonb;p jsonb;b jsonb;a jsonb;tp jsonb;proved jsonb;authority jsonb;expected jsonb;original_row jsonb;
BEGIN
 e:=f->'event';p:=f->'prior';b:=e->'before_row';a:=e->'after_row';tp:=f#>'{player,event,before_row}';
 authority:=f->'authority';
 proved:=smarter_private.original_closed_player_proof(f->'player',lo,hi);
 IF proved->>'status' IS DISTINCT FROM 'ready' OR f IS NULL
 OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
 OR jsonb_typeof(p->'after_row') IS DISTINCT FROM 'object' OR e->>'source_name' IS DISTINCT FROM 'table_seats'
 OR e->>'operation' IS DISTINCT FROM 'UPDATE' OR b-'left_at' IS DISTINCT FROM (p->'after_row')-'left_at'
 OR p#>'{after_row,left_at}' IS DISTINCT FROM 'null'::jsonb OR b->>'left_at' IS NULL
 OR a-ARRAY['left_at','joined_at','occupancy_id'] IS DISTINCT FROM b-ARRAY['left_at','joined_at','occupancy_id']
 OR a->'left_at' IS DISTINCT FROM 'null'::jsonb OR a->>'occupancy_id' IS NULL OR a->>'occupancy_id'=b->>'occupancy_id'
 OR a->>'joined_at' IS NULL OR (a->>'joined_at')::timestamptz<=(b->>'left_at')::timestamptz
 OR (a->>'joined_at')::timestamptz>=hi OR hi<=(e->>'observed_at')::timestamptz
 OR b->>'user_id' IS DISTINCT FROM tp->>'user_id'
 OR b->>'table_id' IS DISTINCT FROM authority->>'table_id'
 OR b->>'id' IS DISTINCT FROM authority->>'seat_id' OR b->>'user_id' IS DISTINCT FROM authority->>'user_id'
 OR tp->>'id' IS DISTINCT FROM authority->>'registration_id' OR tp->>'tournament_id' IS DISTINCT FROM authority->>'tournament_id'
 OR (b->>'stack')::numeric IS DISTINCT FROM (authority->>'starting_stack')::numeric OR (b->>'stack')::numeric<=0
 OR NOT(f#>'{player,terminal_fixture,terminal,source_seat_ids}' ? (b->>'id'))
 OR NOT(f#>'{player,terminal_fixture,terminal,closed_table_ids}' ? (b->>'table_id'))
 OR e->>'transaction_id' IS DISTINCT FROM f#>>'{player,event,transaction_id}'
 OR (p->>'event_id')::bigint >= (e->>'event_id')::bigint
 THEN RETURN jsonb_build_object('status','blocked','reason','original_native_chair_refused');END IF;
 IF authority->>'class'='undealt_paid_entry' THEN
  IF authority->>'version' IS DISTINCT FROM '20261007024455' OR authority->>'source_md5' IS DISTINCT FROM '71c1904782272e10246d056862447ea8'
  OR f#>>'{restoration,transaction_id}' IS DISTINCT FROM e->>'transaction_id'
  OR f#>>'{restoration,qualification_hash}' IS DISTINCT FROM md5((f->>'expected_raw')::jsonb::text)
  THEN RETURN jsonb_build_object('status','blocked','reason','original_undealt_qualification_refused');END IF;
  expected:=(f->>'expected_raw')::jsonb;
  SELECT x INTO original_row FROM jsonb_array_elements(expected->'rows')x WHERE x#>>'{seat,id}'=b->>'id';
  IF original_row IS NULL OR original_row#>>'{roster,id}' IS DISTINCT FROM tp->>'id'
  OR original_row#>>'{seat,occupancy_id}' IS DISTINCT FROM b->>'occupancy_id'
  OR (original_row#>>'{seat,stack}')::numeric IS DISTINCT FROM (b->>'stack')::numeric
  OR NOT EXISTS(SELECT FROM jsonb_array_elements(f#>'{restoration,native_results}')r WHERE r->>'seat_id'=b->>'id'
   AND r->>'table_id'=b->>'table_id' AND r->>'user_id'=b->>'user_id' AND r->'ok'='true'::jsonb
   AND r->'replayed'='false'::jsonb AND (r->>'stack')::numeric=(b->>'stack')::numeric)
  THEN RETURN jsonb_build_object('status','blocked','reason','original_undealt_native_assignment_refused');END IF;
 ELSIF authority->>'class'='original_four_spin' THEN
  IF authority->>'version' IS DISTINCT FROM '20261007132839' OR authority->>'source_md5' IS DISTINCT FROM 'f99c99c31d0aedac3466e106714c4fb5' THEN
   RETURN jsonb_build_object('status','blocked','reason','original_spin_source_refused');END IF;
 ELSE RETURN jsonb_build_object('status','blocked','reason','unknown_original_assignment');END IF;
 RETURN jsonb_build_object('status','ready','financial_admission',false,'event_id',e->'event_id',
 'original_paid_entry_reproved',true,'original_owner',proved->'original_owner','original_stack_unchanged',true,'original_closed_held',0,
 'missing_force_event_invented',false,'raw_history_rewritten',false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
 RETURN jsonb_build_object('status','blocked','reason','malformed_original');
END $proof$;
