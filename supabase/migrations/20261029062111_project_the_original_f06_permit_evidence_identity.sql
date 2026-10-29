-- Return the original permit's actual evidence identity to canonical recovery readers.
-- Compatible projection only: authority, shared lane, rows and financial guards unchanged.
-- @live-proof: EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_hand_number_state(uuid,uuid,uuid)') AND md5(p.prosrc)='c71e331cc40d676c931f2d711f2d02a0' AND md5(pg_get_functiondef(p.oid))='570441684fd001cd76d4591e04194b98' AND position('''evidence_id'',h.evidence_id' IN p.prosrc)>0 AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $projection$
DECLARE f regprocedure := 'public.fn_f06_hand_number_state(uuid,uuid,uuid)'::regprocedure; d text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=f AND md5(p.prosrc)='f0a9d0fc1e897acfc9c61fa3c72d0e04'
 AND md5(pg_get_functiondef(p.oid))='3d11dc858210c0ea3daec4a671791f5b'
 AND p.proowner='postgres'::regrole AND p.prosecdef
 AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
 AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN
 RAISE EXCEPTION 'F06_PERMIT_PROJECTION_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 d:=pg_get_functiondef(f);
 IF length(d)-length(replace(d,'''generation'',h.generation,''state'',h.state)',''))<>length('''generation'',h.generation,''state'',h.state)') THEN
 RAISE EXCEPTION 'F06_PERMIT_PROJECTION_SHAPE_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(d,'''generation'',h.generation,''state'',h.state)','''generation'',h.generation,''state'',h.state,''evidence_id'',h.evidence_id)');
 IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_hand_number_state(uuid,uuid,uuid)') AND md5(p.prosrc)='c71e331cc40d676c931f2d711f2d02a0' AND md5(pg_get_functiondef(p.oid))='570441684fd001cd76d4591e04194b98' AND position('''evidence_id'',h.evidence_id' IN p.prosrc)>0 AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_PERMIT_PROJECTION_POSTIMAGE_CHANGED' USING ERRCODE='55000'; END IF;
END $projection$;
COMMIT;
