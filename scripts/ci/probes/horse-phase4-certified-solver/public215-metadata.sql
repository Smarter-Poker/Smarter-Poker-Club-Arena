DO $test$
BEGIN
 IF NOT public.fn_gto_v31_public215_cards('2c3d4h','["5c","6d"]') OR public.fn_gto_v31_public215_cards('2c2c4h','["5c","6d"]') OR public.fn_gto_v31_public215_cards('2c3d4h','["6d","5c"]') OR public.fn_gto_v31_public215_cards('2c3d4h','["2c","6d"]') OR public.fn_gto_v31_public215_cards(NULL,NULL) THEN RAISE EXCEPTION 'canonical legal card guard';END IF;
 IF NOT public.fn_gto_v31_public215_keys('{"a":1}',ARRAY['a']) OR public.fn_gto_v31_public215_keys('{"a":1,"b":2}',ARRAY['a']) OR public.fn_gto_v31_public215_keys(NULL,ARRAY['a']) THEN RAISE EXCEPTION 'strict object keys';END IF;
 IF public.fn_gto_v31_public215_runtime_protocol_valid('{}','[]') OR public.fn_gto_v31_public215_runtime_protocol_valid(NULL,'[]') THEN RAISE EXCEPTION 'incomplete parity protocol accepted';END IF;
 RAISE NOTICE 'PUBLIC215_NEW_METADATA_GUARDS_PASS';
END $test$;
DO $numeric$
DECLARE a jsonb:='{"long":true,"a":[1e-6,-0.0,1.0]}';b jsonb:='{"z":-0.0,"a":1e-6,"aa":[1,1.0],"b":true}';matrix jsonb;
BEGIN
 IF a::text<>'{"a": [0.000001, 0.0, 1.0], "long": true}' OR public.fn_gto_v31_node_checksum(a)<>'171791a0aba1e35887011751b1386e5c0d1e040e1bf1e734b71feda55cd3c890' THEN RAISE EXCEPTION 'public numeric PgJSON renderer oracle1';END IF;
 IF encode(digest(convert_to(public.fn_training_canonical_jsonb_text_v1(a),'UTF8'),'sha256'),'hex')<>'cb368698894c500a907bdfca9970d36619013c0cf7d80ea4a0752e2184b66788' OR public.fn_gto_v31_node_checksum(b)<>'99ed12f5a254ad5848d34f47a223101f18c87bf9cb994a107e058a2c2830344c' THEN RAISE EXCEPTION 'public numeric compact/PgJSON renderer oracle2';END IF;
 matrix:=jsonb_build_object('schema','s','combo_order','c','nodes',jsonb_build_array(b||jsonb_build_object('node_checksum',public.fn_gto_v31_node_checksum(b))));
 IF public.fn_gto_v31_source_artifact_checksum('public-only',matrix)<>'b61ed30354b4ed159a9b6d94a968bde3a32c24675d09db1ecd58ce0b6a37c641' THEN RAISE EXCEPTION 'public numeric source artifact renderer oracle';END IF;
 RAISE NOTICE 'PUBLIC215_PG17_SYNTHETIC_NUMERIC_IDENTITY_PARITY_PASS';
END $numeric$;
DO $transport$
DECLARE b jsonb:='{"z":0,"a":0.000001,"aa":[1,1],"b":true}';matrix jsonb;
BEGIN
 IF public.fn_gto_v31_node_checksum(b)<>'03954c15e26f5088b9e16a55ff3762f43a9ab6f1859d25cae8a41ea8f4fa0d2b'THEN RAISE EXCEPTION 'actual gateway-normalized PgJSON node identity';END IF;
 matrix:=jsonb_build_object('schema','s','combo_order','c','nodes',jsonb_build_array(b||jsonb_build_object('node_checksum',public.fn_gto_v31_node_checksum(b))));
 IF public.fn_gto_v31_source_artifact_checksum('public-only',matrix)<>'b02cfb6725ffc5c6006dae3a10aaa92141323c668c6f17c573e1debdfc4a2f45'THEN RAISE EXCEPTION 'actual gateway-normalized source identity';END IF;
 RAISE NOTICE 'PUBLIC215_GATEWAY_NORMALIZED_PG17_SYNTHETIC_IDENTITY_PASS';
END $transport$;
