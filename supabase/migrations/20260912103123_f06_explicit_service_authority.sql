-- F06 public engine authority: explicit statements preserve installed service-only permissions.
-- The original 20260912100322 definitions and guarded dynamic grants remain immutable.
-- This additive record changes no function body, owner, policy, financial state or effective permission.
-- MCP owns the transaction; fail before or after any declaration if exact authority has changed.
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';

DO $f06_explicit_acl_guard$
DECLARE e jsonb; target oid; seen integer;
BEGIN
 SELECT count(*) INTO seen FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('fn_ca_commit_hand_settlement','fn_f06_ack_cleanup','fn_f06_amend_attempt','fn_f06_begin_break','fn_f06_begin_hand','fn_f06_claim_custody','fn_f06_close_break','fn_f06_discover_breaks','fn_f06_finish_hand','fn_f06_request_park','fn_move_tournament_player');
 IF seen <> 11 THEN RAISE EXCEPTION 'F06 explicit ACL authority set changed'; END IF;
 FOR e IN SELECT value FROM pg_catalog.jsonb_array_elements('[{"signature":"public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)","sha256":"d7f935f3a50e1ebb8fc20f9f71e40c45490ba2c51748556feba100cbe61615a6","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_ack_cleanup(uuid,uuid,uuid,uuid,bigint,text)","sha256":"c9793a23dff912df56888979c2374afdc4cfa1e55924e36cccd211da6688cba8","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_amend_attempt(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,text)","sha256":"ed213727e005842eea8a5e103b05e06e698c5c7d69d44c104fbcb595efe45633","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_begin_break(uuid,uuid,uuid,jsonb)","sha256":"973e45968852b6fe0f1990dc9ba9bc49d8940d9a7f97f76929c6829f47427dd1","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)","sha256":"9f439d47d88d6682d2bddca339c8c0112a7301d9a2c17946d4d847ca50b6b869","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_claim_custody(uuid,uuid,uuid,uuid,bigint)","sha256":"de15c1d6c3693f3ce60caca3faecba271fce46b02ca86f4dec72d49dcc25ea44","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_close_break(uuid,uuid,uuid)","sha256":"b0e71bbb31eb2c68c3dc593b2080fa435552e741e46ee0c19592dafeb000b97b","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_discover_breaks(uuid,uuid,bigint,integer)","sha256":"fbd222aa3d3be1d7f93ef817c85ef2af4f02db83674ecbc83e9254b335ea31c0","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)","sha256":"738d1dc9096d01064395b05f3e2eaceaf0ff42d7a06a7c6e02c43549c3bf38e2","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_request_park(uuid,uuid,uuid,uuid,bigint,uuid)","sha256":"f5ad65c72a5f452a3cf51e56371e79f08e2b7e54305545c9980514376a1c4bb8","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)","sha256":"5e9ee741354bfead3cdf8624491ccc251b12cf2d2525be43d408699067e3ae1c","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"}]'::jsonb) LOOP
  target := pg_catalog.to_regprocedure(e->>'signature');
  IF target IS NULL OR NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=target
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex')=e->>'sha256'
    AND pg_catalog.pg_get_userbyid(p.proowner)=e->>'owner'
    AND p.proacl::text=e->>'acl'
    AND p.prosecdef
    AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
    AND pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
  ) THEN RAISE EXCEPTION 'F06 explicit ACL preimage changed for %', e->>'signature'; END IF;
 END LOOP;
END $f06_explicit_acl_guard$;

REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_ack_cleanup(uuid,uuid,uuid,uuid,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_ack_cleanup(uuid,uuid,uuid,uuid,bigint,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_amend_attempt(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_amend_attempt(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_begin_break(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_begin_break(uuid,uuid,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_claim_custody(uuid,uuid,uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_claim_custody(uuid,uuid,uuid,uuid,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_close_break(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_close_break(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_discover_breaks(uuid,uuid,bigint,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_discover_breaks(uuid,uuid,bigint,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_f06_request_park(uuid,uuid,uuid,uuid,bigint,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_request_park(uuid,uuid,uuid,uuid,bigint,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text) TO service_role;

DO $f06_explicit_acl_guard$
DECLARE e jsonb; target oid; seen integer;
BEGIN
 SELECT count(*) INTO seen FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('fn_ca_commit_hand_settlement','fn_f06_ack_cleanup','fn_f06_amend_attempt','fn_f06_begin_break','fn_f06_begin_hand','fn_f06_claim_custody','fn_f06_close_break','fn_f06_discover_breaks','fn_f06_finish_hand','fn_f06_request_park','fn_move_tournament_player');
 IF seen <> 11 THEN RAISE EXCEPTION 'F06 explicit ACL authority set changed'; END IF;
 FOR e IN SELECT value FROM pg_catalog.jsonb_array_elements('[{"signature":"public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)","sha256":"d7f935f3a50e1ebb8fc20f9f71e40c45490ba2c51748556feba100cbe61615a6","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_ack_cleanup(uuid,uuid,uuid,uuid,bigint,text)","sha256":"c9793a23dff912df56888979c2374afdc4cfa1e55924e36cccd211da6688cba8","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_amend_attempt(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,text)","sha256":"ed213727e005842eea8a5e103b05e06e698c5c7d69d44c104fbcb595efe45633","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_begin_break(uuid,uuid,uuid,jsonb)","sha256":"973e45968852b6fe0f1990dc9ba9bc49d8940d9a7f97f76929c6829f47427dd1","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)","sha256":"9f439d47d88d6682d2bddca339c8c0112a7301d9a2c17946d4d847ca50b6b869","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_claim_custody(uuid,uuid,uuid,uuid,bigint)","sha256":"de15c1d6c3693f3ce60caca3faecba271fce46b02ca86f4dec72d49dcc25ea44","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_close_break(uuid,uuid,uuid)","sha256":"b0e71bbb31eb2c68c3dc593b2080fa435552e741e46ee0c19592dafeb000b97b","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_discover_breaks(uuid,uuid,bigint,integer)","sha256":"fbd222aa3d3be1d7f93ef817c85ef2af4f02db83674ecbc83e9254b335ea31c0","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)","sha256":"738d1dc9096d01064395b05f3e2eaceaf0ff42d7a06a7c6e02c43549c3bf38e2","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_f06_request_park(uuid,uuid,uuid,uuid,bigint,uuid)","sha256":"f5ad65c72a5f452a3cf51e56371e79f08e2b7e54305545c9980514376a1c4bb8","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"},{"signature":"public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)","sha256":"5e9ee741354bfead3cdf8624491ccc251b12cf2d2525be43d408699067e3ae1c","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}"}]'::jsonb) LOOP
  target := pg_catalog.to_regprocedure(e->>'signature');
  IF target IS NULL OR NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=target
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex')=e->>'sha256'
    AND pg_catalog.pg_get_userbyid(p.proowner)=e->>'owner'
    AND p.proacl::text=e->>'acl'
    AND p.prosecdef
    AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
    AND pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
  ) THEN RAISE EXCEPTION 'F06 explicit ACL preimage changed for %', e->>'signature'; END IF;
 END LOOP;
END $f06_explicit_acl_guard$;
