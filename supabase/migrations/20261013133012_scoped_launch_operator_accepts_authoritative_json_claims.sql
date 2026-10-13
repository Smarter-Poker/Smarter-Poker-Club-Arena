-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid))='e58e29cddfd9d9594fce237a61bc97bc' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid))='46b476b5204bb45fc4a5e87a44c27df8' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_engine_operator_observe(uuid,text,jsonb)')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid))='dafc851e32847d01bb0b31a1ebe0f708' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_launch_operator_command(uuid,uuid,text,text,uuid)')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid))='1e8cb00f06dbd355b6b6968a359abe14' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_finish_cash_close(uuid,uuid)')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid))='c361537b74dd7b12f05cc58bd0d2ef4f' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_cancelled_tournament_evidence_is_immutable()')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid))='b4012023e95bf3ee041776a03bd2d731' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_satellite_transfer_ledger_is_immutable()')) IS TRUE
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid))='1b3ab2bd7823977943d1baa0816997d0' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_terminal_tournament_evidence_is_immutable()')) IS TRUE
-- Fix the live launch blockers: PostgREST supplies JSON claims, and escrow
-- trigger rows do not have chip_ledger.metadata. Keep every original scope,
-- actor, duplicate-operation, closing-evidence and immutable-money predicate.
-- No balances, grants, schedules, engine or reset operation change here.
BEGIN;
SET LOCAL lock_timeout='4s';
DO $launch_transport$
DECLARE r record; original text; expected text; authority jsonb; after_authority jsonb; old_anchor text; new_anchor text;
BEGIN
 IF md5(pg_get_functiondef('auth.role()'::regprocedure)) IS DISTINCT FROM '8a3e05459e07e0633d43c6fba2a2cdf4' THEN RAISE EXCEPTION 'LAUNCH_TRANSPORT_AUTH_READER_CHANGED'; END IF;
 FOR r IN SELECT * FROM (VALUES
('fn_ca_engine_operator_command(uuid,uuid,text,text,text)','4b7b98f6d92147ae076edc1e7f844a7b','e58e29cddfd9d9594fce237a61bc97bc','claims'),
('fn_ca_engine_operator_observe(uuid,text,jsonb)','65a2ba203f3783e0b72658ab759f5511','46b476b5204bb45fc4a5e87a44c27df8','claims'),
('fn_ca_launch_operator_command(uuid,uuid,text,text,uuid)','353914f6ac96cc6cc3e2b9e28abd1c4b','dafc851e32847d01bb0b31a1ebe0f708','claims'),
('fn_ca_operator_finish_cash_close(uuid,uuid)','ce561f39be083a7576846e3b891668e0','1e8cb00f06dbd355b6b6968a359abe14','claims'),
('fn_cancelled_tournament_evidence_is_immutable()','81ae3f029dd35dd585e14e022a2a815a','c361537b74dd7b12f05cc58bd0d2ef4f','typed'),
('fn_satellite_transfer_ledger_is_immutable()','2dd326b34869aa3a3fcfa4ab366ebebd','b4012023e95bf3ee041776a03bd2d731','typed'),
('fn_terminal_tournament_evidence_is_immutable()','df4f9c6132fd978d4683a8ed8bab52f4','1b3ab2bd7823977943d1baa0816997d0','typed')
 ) v(signature,preimage,postimage,kind) LOOP
  SELECT pg_get_functiondef(p.oid),jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig)
  INTO original,authority FROM pg_catalog.pg_proc p WHERE p.oid=('public.'||r.signature)::regprocedure;
  IF md5(original) IS DISTINCT FROM r.preimage THEN RAISE EXCEPTION 'LAUNCH_TRANSPORT_PREIMAGE_CHANGED: %',r.signature; END IF;
  IF authority->>'owner' IS DISTINCT FROM 'postgres' OR (authority->>'security_definer')::boolean IS DISTINCT FROM true
  OR authority->>'acl' IS DISTINCT FROM (CASE WHEN r.kind='claims' THEN '{postgres=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres}' END)
  OR authority->'config' IS DISTINCT FROM (CASE WHEN r.kind='claims' THEN '["search_path=public, pg_temp"]'::jsonb ELSE '["search_path=public"]'::jsonb END)
  THEN RAISE EXCEPTION 'LAUNCH_TRANSPORT_AUTHORITY_CHANGED'; END IF;
  old_anchor:=CASE WHEN r.kind='claims' THEN $old$current_setting('request.jwt.claim.role',true)$old$ ELSE $old$NEW.metadata->>'entry_kind'$old$ END;
  new_anchor:=CASE WHEN r.kind='claims' THEN 'auth.role()' ELSE $new$to_jsonb(NEW)->'metadata'->>'entry_kind'$new$ END;
  IF (length(original)-length(replace(original,old_anchor,'')))/length(old_anchor)<>1 THEN RAISE EXCEPTION 'LAUNCH_TRANSPORT_EXACT_ANCHOR_CHANGED'; END IF;
  expected:=replace(original,old_anchor,new_anchor);
  IF md5(expected) IS DISTINCT FROM r.postimage THEN RAISE EXCEPTION 'LAUNCH_TRANSPORT_EXPECTED_POSTIMAGE_CHANGED'; END IF;
  EXECUTE expected;
  SELECT jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig)
  INTO after_authority FROM pg_catalog.pg_proc p WHERE p.oid=('public.'||r.signature)::regprocedure;
  IF after_authority IS DISTINCT FROM authority OR md5(pg_get_functiondef(('public.'||r.signature)::regprocedure)) IS DISTINCT FROM r.postimage THEN RAISE EXCEPTION 'LAUNCH_TRANSPORT_INSTALLED_POSTIMAGE_CHANGED'; END IF;
 END LOOP;
END $launch_transport$;
COMMIT;
