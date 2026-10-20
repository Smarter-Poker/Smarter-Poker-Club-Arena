-- R2 writes the club whose actual wallet moved, including the callable v3
-- fallback and owner-discharge route. NULL journals previously appeared in
-- every club Cashier for a shared user despite exact canonical club ledgers.
-- Only six new journal club pointers change. No historic rows, money, sources,
-- keys, invoices, reserves or routing rules are changed or replayed.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure))='3024be85714699035ad0a81384177ffb' AND md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='9c3930b7e02376d631bc6b4a3876a74b' AND md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='9684d9773ff663ffc85969af5eec43f4' AND smarter_private.original_inventory_proof_sources_match() IS TRUE)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $install$
DECLARE r record; d text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR nullif(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR nullif(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'commission_club_operator_refused'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL OR nullif(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'commission_club_freeze_refused'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'commission_club_scheduler_owned'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261020163005') THEN RAISE EXCEPTION 'commission_club_history_replay'; END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'commission_club_inventory_source_guard'; END IF;
 FOR r IN SELECT * FROM (VALUES
 ('public.fn_accounting_legacy_pay_week(uuid)','d3a9e77dc3231ab18a9a5671509ddf79','{postgres=X/postgres,service_role=X/postgres}'),
 ('public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)','299975706a6b2ad943909e56a967d88c','{postgres=X/postgres}'),
 ('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)','4c10a048c2a137f7bd3c882250d1eb7a','{postgres=X/postgres}')
 )v(signature,prehash,acl) LOOP
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure(r.signature) AND md5(pg_get_functiondef(p.oid))=r.prehash AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text=r.acl AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'commission_club_preimage_authority_changed:%',r.signature; END IF;
 END LOOP;
 d:=pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure);
 d:=replace(d,$old$  IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)$old$,$new$  IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)$new$);
 d:=replace(d,$old$   VALUES(r.payer_id,'PLAYER','debit',r.amount,'commission','Recorded weekly commission budget passed to child agent (owner-authorized legacy week)',payer_after); END IF;$old$,$new$   VALUES(r.payer_id,'PLAYER','debit',r.amount,'commission','Recorded weekly commission budget passed to child agent (owner-authorized legacy week)',payer_after,r.club_id); END IF;$new$);
 d:=replace(d,$old$  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)$old$,$new$  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)$new$);
 d:=replace(d,$old$   VALUES(r.payee_id,'PLAYER','credit',r.amount,'commission','Recorded weekly commission budget received (owner-authorized legacy week)',payee_after);$old$,$new$   VALUES(r.payee_id,'PLAYER','credit',r.amount,'commission','Recorded weekly commission budget received (owner-authorized legacy week)',payee_after,r.club_id);$new$);
 EXECUTE d;
 d:=pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
 d:=replace(d,$old$  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)$old$,$new$  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)$new$);
 d:=replace(d,$old$   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after); END IF;$old$,$new$   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after,v_edge.club_id); END IF;$new$);
 d:=replace(d,$old$  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)$old$,$new$  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)$new$);
 d:=replace(d,$old$   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after);$old$,$new$   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after,v_edge.club_id);$new$);
 EXECUTE d;
 d:=pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
 d:=replace(d,$old$  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)$old$,$new$  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)$new$);
 d:=replace(d,$old$   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after); END IF;$old$,$new$   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after,v_edge.club_id); END IF;$new$);
 d:=replace(d,$old$  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)$old$,$new$  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)$new$);
 d:=replace(d,$old$   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after);$old$,$new$   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after,v_edge.club_id);$new$);
 EXECUTE d;
 IF NOT (md5(pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure))='3024be85714699035ad0a81384177ffb' AND md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='9c3930b7e02376d631bc6b4a3876a74b' AND md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='9684d9773ff663ffc85969af5eec43f4') THEN RAISE EXCEPTION 'commission_club_postimage_changed'; END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'commission_club_inventory_source_guard_changed'; END IF;
END $install$;
COMMIT;
