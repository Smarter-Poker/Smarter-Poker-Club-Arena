BEGIN;
CREATE FUNCTION pg_temp.valid(v_l_value jsonb)RETURNS boolean LANGUAGE plpgsql AS $v$
DECLARE v_l_key jsonb:='{"k":1}';v_l_witness jsonb:='{"links":1}';v_generation text:='GEN';v_hand_projected boolean:=true;v_l_valid boolean;v_l_counts jsonb;v_l_name text;v_l_number numeric;
BEGIN

 v_l_valid:=false;
 IF jsonb_typeof(v_l_value)='object'
 AND v_l_value->>'contract'='canonical-linked-validation-v1'
 AND v_l_value->>'generation'=v_generation
 AND v_l_value->'projected'=to_jsonb(v_hand_projected)
 AND v_l_value->>'reader_md5'='0c3a826553e9ef65a03030c3ef78eaaf'
 AND v_l_value->>'witness_md5'='a3b1c75ad2b122dc0b0fede8a66813c8'
 AND v_l_value->'input_key'=v_l_key
 AND v_l_value->'witness'=v_l_witness
 AND v_l_value->>'proof_md5'=md5((v_l_value-'proof_md5')::text)
 AND jsonb_typeof(v_l_value->'counts')='object' THEN
  v_l_counts:=v_l_value->'counts';v_l_valid:=true;
  IF(SELECT array_agg(key ORDER BY key)FROM jsonb_object_keys(v_l_counts)key)
    IS DISTINCT FROM ARRAY['bad','resolved','rows','unknown']THEN v_l_valid:=false;END IF;
  IF v_l_valid THEN
   FOREACH v_l_name IN ARRAY ARRAY['rows','bad','resolved','unknown']LOOP
    IF jsonb_typeof(v_l_counts->v_l_name)IS DISTINCT FROM'number'
     OR(v_l_counts->>v_l_name)!~'^[0-9]{1,19}$'THEN v_l_valid:=false;EXIT;END IF;
    v_l_number:=(v_l_counts->>v_l_name)::numeric;
    IF v_l_number>9223372036854775807 THEN v_l_valid:=false;EXIT;END IF;
   END LOOP;
  END IF;
  IF v_l_valid THEN
   IF (v_l_counts->>'rows')::numeric IS DISTINCT FROM
    (v_l_counts->>'bad')::numeric+(v_l_counts->>'resolved')::numeric+(v_l_counts->>'unknown')::numeric THEN v_l_valid:=false;END IF;
  END IF;
 END IF;
 RETURN v_l_valid;END;$v$;

DO $cases$DECLARE b jsonb;x jsonb;n int:=0;counts jsonb;BEGIN
 b:=jsonb_build_object('contract','canonical-linked-validation-v1','generation','GEN','projected',true,'reader_md5','0c3a826553e9ef65a03030c3ef78eaaf','witness_md5','a3b1c75ad2b122dc0b0fede8a66813c8','input_key','{"k":1}'::jsonb,'witness','{"links":1}'::jsonb,'counts','{"rows":1,"bad":0,"resolved":1,"unknown":0}'::jsonb);
 x:=b||jsonb_build_object('proof_md5',md5(b::text));
 IF pg_temp.valid(x)IS DISTINCT FROM true THEN RAISE EXCEPTION 'valid_refused';END IF;n:=n+1;
 FOR counts IN SELECT value FROM jsonb_array_elements('[{"rows":0,"bad":0,"resolved":0,"unknown":0},{"rows":2,"bad":1,"resolved":0,"unknown":1}]')LOOP
  x:=jsonb_set(b,'{counts}',counts);x:=x||jsonb_build_object('proof_md5',md5(x::text));IF pg_temp.valid(x)IS DISTINCT FROM true THEN RAISE EXCEPTION 'valid_edge_refused:%',counts;END IF;n:=n+1;
 END LOOP;
 FOR counts IN SELECT value FROM jsonb_array_elements('[{"rows":"oops","bad":0,"resolved":1,"unknown":0},{"rows":-1,"bad":0,"resolved":0,"unknown":0},{"rows":1.5,"bad":0,"resolved":1,"unknown":0},{"rows":9223372036854775808,"bad":0,"resolved":1,"unknown":0},{"rows":2,"bad":0,"resolved":1,"unknown":0},{"rows":1,"bad":0,"resolved":1},{"rows":1,"bad":0,"resolved":1,"unknown":0,"extra":0},{"rows":1,"bad":null,"resolved":1,"unknown":0},null,[]]')LOOP
  x:=jsonb_set(b,'{counts}',counts);x:=x||jsonb_build_object('proof_md5',md5(x::text));IF pg_temp.valid(x)IS DISTINCT FROM false THEN RAISE EXCEPTION 'malformed_accepted:%',counts;END IF;n:=n+1;
 END LOOP;
 FOR x IN SELECT value FROM jsonb_array_elements(jsonb_build_array(b||'{"generation":"OTHER"}'::jsonb,b||'{"input_key":{"k":2}}'::jsonb,b||'{"witness":{"links":2}}'::jsonb,b||'{"reader_md5":"OTHER"}'::jsonb,b||'{"projected":false}'::jsonb))LOOP
  x:=x||jsonb_build_object('proof_md5',md5(x::text));IF pg_temp.valid(x)IS DISTINCT FROM false THEN RAISE EXCEPTION 'binding_accepted';END IF;n:=n+1;
 END LOOP;
 RAISE NOTICE 'VALIDATOR_CASES_PASS:%',n;
END;$cases$;
ROLLBACK;
