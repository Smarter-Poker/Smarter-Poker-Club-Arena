-- SOURCE ONLY / UNRUN. Component35 preserves every preceding authority byte.
BEGIN;
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';
DO $guard$ DECLARE sig text;who text;actual jsonb;BEGIN
 IF current_user<>'postgres' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN RAISE EXCEPTION 'accounting_observer_owner_version_required';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_accounting_run_observation_v1') THEN RAISE EXCEPTION 'accounting_observer_preexists';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_open_settlement_period(uuid)') AND md5(pg_get_functiondef(oid))='da3ac3fce43c8b7b4a58f70158bd9f14' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=to_regprocedure('public.fn_open_settlement_period(uuid)')) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'legacy_period_function_preimage_changed' USING DETAIL='fn_open_settlement_period(uuid)';END IF;
 IF has_function_privilege('anon','public.fn_open_settlement_period(uuid)','EXECUTE') OR has_function_privilege('authenticated','public.fn_open_settlement_period(uuid)','EXECUTE') IS DISTINCT FROM true OR has_function_privilege('service_role','public.fn_open_settlement_period(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'accounting_observer_dependency_access_changed' USING DETAIL='fn_open_settlement_period(uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_set_settlement_period_status(uuid,text)') AND md5(pg_get_functiondef(oid))='e4ca93cd7fd10d0a8da485eac492e192' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=to_regprocedure('public.fn_set_settlement_period_status(uuid,text)')) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'legacy_period_function_preimage_changed' USING DETAIL='fn_set_settlement_period_status(uuid,text)';END IF;
 IF has_function_privilege('anon','public.fn_set_settlement_period_status(uuid,text)','EXECUTE') OR has_function_privilege('authenticated','public.fn_set_settlement_period_status(uuid,text)','EXECUTE') IS DISTINCT FROM true OR has_function_privilege('service_role','public.fn_set_settlement_period_status(uuid,text)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'accounting_observer_dependency_access_changed' USING DETAIL='fn_set_settlement_period_status(uuid,text)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.get_current_settlement_period()') AND md5(pg_get_functiondef(oid))='6e670854dbcbd50fb8527e2a99146dca' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=to_regprocedure('public.get_current_settlement_period()')) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'legacy_period_function_preimage_changed' USING DETAIL='get_current_settlement_period()';END IF;
 IF has_function_privilege('anon','public.get_current_settlement_period()','EXECUTE') OR has_function_privilege('authenticated','public.get_current_settlement_period()','EXECUTE') IS DISTINCT FROM true OR has_function_privilege('service_role','public.get_current_settlement_period()','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'accounting_observer_dependency_access_changed' USING DETAIL='get_current_settlement_period()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.get_current_settlement_period(uuid)') AND md5(pg_get_functiondef(oid))='e357bd34de0afe73e449564ea1c13cbe' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=to_regprocedure('public.get_current_settlement_period(uuid)')) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'legacy_period_function_preimage_changed' USING DETAIL='get_current_settlement_period(uuid)';END IF;
 IF has_function_privilege('anon','public.get_current_settlement_period(uuid)','EXECUTE') OR has_function_privilege('authenticated','public.get_current_settlement_period(uuid)','EXECUTE') IS DISTINCT FROM true OR has_function_privilege('service_role','public.get_current_settlement_period(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'accounting_observer_dependency_access_changed' USING DETAIL='get_current_settlement_period(uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.ca_can_oversee_union(uuid)') AND md5(pg_get_functiondef(oid))='79cb90482aa4af61ea4e6a286768efa4' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=to_regprocedure('public.ca_can_oversee_union(uuid)')) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'accounting_observer_dependency_preimage_changed' USING DETAIL='ca_can_oversee_union(uuid)';END IF;
 IF has_function_privilege('anon','public.ca_can_oversee_union(uuid)','EXECUTE') OR has_function_privilege('authenticated','public.ca_can_oversee_union(uuid)','EXECUTE') IS DISTINCT FROM true OR has_function_privilege('service_role','public.ca_can_oversee_union(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'accounting_observer_dependency_access_changed' USING DETAIL='ca_can_oversee_union(uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.ca_can_view_club(uuid)') AND md5(pg_get_functiondef(oid))='0fa2974fd5b8d2b3b8089a1c172cbd7a' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=to_regprocedure('public.ca_can_view_club(uuid)')) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'accounting_observer_dependency_preimage_changed' USING DETAIL='ca_can_view_club(uuid)';END IF;
 IF has_function_privilege('anon','public.ca_can_view_club(uuid)','EXECUTE') OR has_function_privilege('authenticated','public.ca_can_view_club(uuid)','EXECUTE') IS DISTINCT FROM true OR has_function_privilege('service_role','public.ca_can_view_club(uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'accounting_observer_dependency_access_changed' USING DETAIL='ca_can_view_club(uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_accounting_party_users(text,uuid)') AND md5(pg_get_functiondef(oid))='2436b25400e0ee73dbbe3158fdb47b0d' AND proowner='postgres'::regrole AND prosecdef=true) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=to_regprocedure('public.fn_accounting_party_users(text,uuid)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'accounting_observer_dependency_preimage_changed' USING DETAIL='fn_accounting_party_users(text,uuid)';END IF;
 IF has_function_privilege('anon','public.fn_accounting_party_users(text,uuid)','EXECUTE') OR has_function_privilege('authenticated','public.fn_accounting_party_users(text,uuid)','EXECUTE') IS DISTINCT FROM false OR has_function_privilege('service_role','public.fn_accounting_party_users(text,uuid)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'accounting_observer_dependency_access_changed' USING DETAIL='fn_accounting_party_users(text,uuid)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_union_accounting_run_at(timestamp with time zone)') AND md5(pg_get_functiondef(oid))='85e9f0ab83b1655a90af953c0d547117' AND proowner='postgres'::regrole AND prosecdef=false) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=to_regprocedure('public.fn_union_accounting_run_at(timestamp with time zone)')) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'accounting_observer_dependency_preimage_changed' USING DETAIL='fn_union_accounting_run_at(timestamp with time zone)';END IF;
 IF has_function_privilege('anon','public.fn_union_accounting_run_at(timestamp with time zone)','EXECUTE') OR has_function_privilege('authenticated','public.fn_union_accounting_run_at(timestamp with time zone)','EXECUTE') IS DISTINCT FROM true OR has_function_privilege('service_role','public.fn_union_accounting_run_at(timestamp with time zone)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'accounting_observer_dependency_access_changed' USING DETAIL='fn_union_accounting_run_at(timestamp with time zone)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_union_week_start(timestamp with time zone)') AND md5(pg_get_functiondef(oid))='103f192a228084dad0e4268c36c82c4b' AND proowner='postgres'::regrole AND prosecdef=false) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid=to_regprocedure('public.fn_union_week_start(timestamp with time zone)')) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'accounting_observer_dependency_preimage_changed' USING DETAIL='fn_union_week_start(timestamp with time zone)';END IF;
 IF has_function_privilege('anon','public.fn_union_week_start(timestamp with time zone)','EXECUTE') OR has_function_privilege('authenticated','public.fn_union_week_start(timestamp with time zone)','EXECUTE') IS DISTINCT FROM true OR has_function_privilege('service_role','public.fn_union_week_start(timestamp with time zone)','EXECUTE') IS DISTINCT FROM true THEN RAISE EXCEPTION 'accounting_observer_dependency_access_changed' USING DETAIL='fn_union_week_start(timestamp with time zone)';END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('anon','authenticated') AND (rolsuper OR rolbypassrls OR pg_has_role(rolname,'service_role','USAGE') OR pg_has_role(rolname,'service_role','SET'))) THEN RAISE EXCEPTION 'accounting_observer_role_authority_changed';END IF;
 IF EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname IN('fn_open_settlement_period','fn_set_settlement_period_status','get_current_settlement_period')) THEN RAISE EXCEPTION 'legacy_period_registry_preimage_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.settlement_periods'::regclass AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity AND NOT relforcerowsecurity) THEN RAISE EXCEPTION 'accounting_observer_period_relation_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.settlement_periods'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $cols$[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","identity":"","not_null":true,"generated":""},{"acl":null,"name":"club_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"union_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"period_number","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"year","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"start_at","type":"timestamp with time zone","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"end_at","type":"timestamp with time zone","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"status","type":"text","default":"'open'::text","identity":"","not_null":false,"generated":""},{"acl":null,"name":"total_rake_collected","type":"numeric(15,2)","default":"0","identity":"","not_null":false,"generated":""},{"acl":null,"name":"total_bbj_contributions","type":"numeric(15,2)","default":"0","identity":"","not_null":false,"generated":""},{"acl":null,"name":"total_player_winnings","type":"numeric(15,2)","default":"0","identity":"","not_null":false,"generated":""},{"acl":null,"name":"total_player_losses","type":"numeric(15,2)","default":"0","identity":"","not_null":false,"generated":""},{"acl":null,"name":"total_hands_dealt","type":"integer","default":"0","identity":"","not_null":false,"generated":""},{"acl":null,"name":"settled_at","type":"timestamp with time zone","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"settled_by","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":false,"generated":""},{"acl":null,"name":"updated_at","type":"timestamp with time zone","default":"now()","identity":"","not_null":false,"generated":""},{"acl":null,"name":"total_commissions_paid","type":"numeric(12,2)","default":"0","identity":"","not_null":false,"generated":""},{"acl":null,"name":"notes","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"seated_stack_snapshot","type":"numeric","default":null,"identity":"","not_null":false,"generated":""}]$cols$::jsonb THEN RAISE EXCEPTION 'accounting_observer_period_columns_changed';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl)a WHERE c.oid='public.settlement_periods'::regclass) IS DISTINCT FROM ARRAY['anon=rxt/postgres','authenticated=rxt/postgres','postgres=arwdDxtm/postgres','service_role=arwdDxtm/postgres']::text[] THEN RAISE EXCEPTION 'accounting_observer_period_acl_changed';END IF;
 SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) INTO actual FROM pg_policies p WHERE p.schemaname='public' AND p.tablename='settlement_periods';
 IF actual IS DISTINCT FROM $policies$[{"cmd":"SELECT","qual":"(EXISTS ( SELECT 1\n   FROM club_members cm\n  WHERE ((cm.club_id = settlement_periods.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'agent'::text])))))","roles":["public"],"tablename":"settlement_periods","permissive":"PERMISSIVE","policyname":"settlement_read","schemaname":"public","with_check":null},{"cmd":"ALL","qual":"true","roles":["service_role"],"tablename":"settlement_periods","permissive":"PERMISSIVE","policyname":"settlement_svc","schemaname":"public","with_check":null},{"cmd":"SELECT","qual":"(( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid)))","roles":["authenticated"],"tablename":"settlement_periods","permissive":"PERMISSIVE","policyname":"union_overseer_read","schemaname":"public","with_check":null}]$policies$::jsonb THEN RAISE EXCEPTION 'accounting_observer_period_policies_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) INTO actual FROM pg_trigger t WHERE t.tgrelid='public.settlement_periods'::regclass AND NOT t.tgisinternal;
 IF actual IS DISTINCT FROM $triggers$[{"name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.settlement_periods FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()"},{"name":"zz_closed_period_is_immutable","enabled":"O","definition":"CREATE TRIGGER zz_closed_period_is_immutable BEFORE DELETE OR UPDATE ON public.settlement_periods FOR EACH ROW EXECUTE FUNCTION zz_closed_period_is_immutable()"}]$triggers$::jsonb THEN RAISE EXCEPTION 'accounting_observer_period_triggers_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',conname,'type',contype,'deferred',condeferred,'validated',convalidated,'deferrable',condeferrable,'definition',pg_get_constraintdef(oid)) ORDER BY conname) INTO actual FROM pg_constraint WHERE conrelid='public.settlement_periods'::regclass;
 IF actual IS DISTINCT FROM $constraints$[{"name":"settlement_periods_club_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE"},{"name":"settlement_periods_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)"},{"name":"settlement_periods_status_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((status = ANY (ARRAY['open'::text, 'processing'::text, 'settled'::text, 'disputed'::text, 'closed'::text])))"},{"name":"settlement_periods_union_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (union_id) REFERENCES unions(id) ON DELETE CASCADE"}]$constraints$::jsonb THEN RAISE EXCEPTION 'accounting_observer_period_constraints_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace AND c.relname='settlement_periods_standalone_week'
  AND i.indrelid='public.settlement_periods'::regclass AND i.indisunique AND i.indisvalid AND i.indisready
  AND pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX settlement_periods_standalone_week ON public.settlement_periods USING btree (club_id, start_at, end_at) WHERE ((union_id IS NULL) AND (club_id IS NOT NULL))')
 THEN RAISE EXCEPTION 'accounting_observer_period_index_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_guard_retired_club_mutation()'::regprocedure AND md5(pg_get_functiondef(oid))='b82be212e7ccf2a15637c231861ff993' AND proowner='postgres'::regrole AND prosecdef) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid='public.fn_guard_retired_club_mutation()'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'accounting_observer_dependency_preimage_changed' USING DETAIL='fn_guard_retired_club_mutation()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.zz_closed_period_is_immutable()'::regprocedure AND md5(pg_get_functiondef(oid))='7c50bd632593b3f79950049b427cbd70' AND proowner='postgres'::regrole AND prosecdef) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid='public.zz_closed_period_is_immutable()'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'accounting_observer_dependency_preimage_changed' USING DETAIL='zz_closed_period_is_immutable()';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.union_accounting_runs'::regclass AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity AND NOT relforcerowsecurity) THEN RAISE EXCEPTION 'accounting_observer_journal_relation_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',CASE WHEN a.attgenerated='s' THEN NULL ELSE pg_get_expr(d.adbin,d.adrelid) END,'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.union_accounting_runs'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $runcols$[{"acl":null,"name":"union_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"period_start","type":"timestamp with time zone","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"period_end","type":"timestamp with time zone","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"scheduled_at","type":"timestamp with time zone","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"status","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"attempts","type":"integer","default":"0","identity":"","not_null":true,"generated":""},{"acl":null,"name":"started_at","type":"timestamp with time zone","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"finished_at","type":"timestamp with time zone","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"result","type":"jsonb","default":"'{}'::jsonb","identity":"","not_null":true,"generated":""},{"name":"standalone_club_id","type":"uuid","not_null":false,"default":null,"identity":"","generated":"","acl":null},{"name":"scope_kind","type":"text","not_null":true,"default":null,"identity":"","generated":"s","acl":null},{"name":"scope_id","type":"uuid","not_null":true,"default":null,"identity":"","generated":"s","acl":null},{"name":"last_scheduler_visit_at","type":"timestamp with time zone","not_null":false,"default":null,"identity":"","generated":"","acl":null}]$runcols$::jsonb THEN RAISE EXCEPTION 'accounting_observer_journal_columns_changed';END IF;
 IF (SELECT regexp_replace(pg_get_expr(d.adbin,d.adrelid),'[[:space:]]','','g') FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.union_accounting_runs'::regclass AND a.attname='scope_kind') IS DISTINCT FROM $kind$CASEWHEN(union_idISNOTNULL)THEN'union'::textELSE'club'::textEND$kind$
 OR (SELECT regexp_replace(pg_get_expr(d.adbin,d.adrelid),'[[:space:]]','','g') FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.union_accounting_runs'::regclass AND a.attname='scope_id') IS DISTINCT FROM 'COALESCE(union_id,standalone_club_id)'
 THEN RAISE EXCEPTION 'accounting_observer_journal_scope_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.union_accounting_runs'::regclass AND contype='p' AND convalidated AND pg_get_constraintdef(oid)='PRIMARY KEY (scope_kind, scope_id, period_start, period_end)')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.union_accounting_runs'::regclass AND conname='accounting_run_has_one_scope' AND convalidated AND pg_get_constraintdef(oid)='CHECK (((union_id IS NULL) <> (standalone_club_id IS NULL)))')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.union_accounting_runs'::regclass AND contype='u' AND convalidated AND pg_get_constraintdef(oid)='UNIQUE (union_id, period_start, period_end)')
 THEN RAISE EXCEPTION 'accounting_observer_journal_keys_changed';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl)a WHERE c.oid='public.union_accounting_runs'::regclass) IS DISTINCT FROM ARRAY['authenticated=r/postgres','postgres=arwdDxtm/postgres','service_role=rxtm/postgres']::text[]
  OR (SELECT count(*) FROM pg_policy WHERE polrelid='public.union_accounting_runs'::regclass)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.union_accounting_runs'::regclass AND polname='union_accounting_runs_scoped_read' AND polcmd='r' AND polpermissive AND polroles=ARRAY['authenticated'::regrole::oid])
 THEN RAISE EXCEPTION 'accounting_observer_journal_access_changed';END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.union_accounting_runs'::regclass AND NOT tgisinternal) THEN RAISE EXCEPTION 'accounting_observer_journal_trigger_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_is_union_overseer(uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='5c1b25662b9751fc4152dac8e8b5e6f2' AND proowner='postgres'::regrole AND prosecdef)
  OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid='public.fn_is_union_overseer(uuid,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[]
 THEN RAISE EXCEPTION 'accounting_observer_union_authority_changed';END IF;
END$guard$;
-- The final142600 policy is source-derived, not a fabricated live catalog.
-- Let the same PostgreSQL parser/deparser compile that exact expression on a
-- private temporary LIKE relation; compare the full expression and drop it.
DO $policy_preimage$ DECLARE actual text;expected text;BEGIN
 IF to_regclass('pg_temp.accounting_observer_policy_preimage') IS NOT NULL THEN RAISE EXCEPTION 'accounting_observer_policy_guard_collision';END IF;
 CREATE TEMP TABLE accounting_observer_policy_preimage (LIKE public.union_accounting_runs) ON COMMIT DROP;
 REVOKE ALL ON accounting_observer_policy_preimage FROM PUBLIC,anon,authenticated,service_role;
 CREATE POLICY expected_read ON accounting_observer_policy_preimage FOR SELECT TO authenticated USING(
  (union_id IS NOT NULL AND public.ca_can_oversee_union(union_id)) OR
  (standalone_club_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.fn_accounting_party_users('club',standalone_club_id)p WHERE p.user_id=auth.uid())));
 SELECT pg_get_expr(polqual,polrelid) INTO actual FROM pg_policy WHERE polrelid='public.union_accounting_runs'::regclass AND polname='union_accounting_runs_scoped_read';
 SELECT replace(pg_get_expr(polqual,polrelid),'accounting_observer_policy_preimage.','union_accounting_runs.') INTO expected
  FROM pg_policy WHERE polrelid='pg_temp.accounting_observer_policy_preimage'::regclass AND polname='expected_read';
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'accounting_observer_journal_policy_changed';END IF;
 DROP TABLE pg_temp.accounting_observer_policy_preimage;
END$policy_preimage$;
-- Shared coordinator guard follows; it verifies source only and executes no writer.
DO $coordinator_preimage$
DECLARE
 definition text;
 reconstructed text;
 replacement text;
 previous_step text;
 change record;
 exact_old text:=$exact_old$    SELECT LEAST(v_first,min(q.period_start)) INTO v_first
      FROM public.union_accounting_runs q WHERE q.union_id=v_union.id AND q.status<>'complete'
        AND (v_union.earliest_period_start IS NULL OR q.period_start>=v_first);$exact_old$;
 exact_new text:=$exact_new$    SELECT LEAST(v_first,min(q.period_start)) INTO v_first
      FROM public.union_accounting_runs q WHERE q.union_id=v_union.id
        AND (q.status<>'complete' OR (v_union.earliest_period_start IS NULL
          AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
        AND (v_union.earliest_period_start IS NULL OR q.period_start>=v_first);$exact_new$;
 dispatch_old text:=$dispatch_old$          SELECT u.id,LEAST(u.first_week,(SELECT min(q.period_start) FROM public.union_accounting_runs q
            WHERE q.union_id=u.id AND q.status<>'complete'
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week$dispatch_old$;
 dispatch_new text:=$dispatch_new$          SELECT u.id,LEAST(u.first_week,(SELECT min(q.period_start) FROM public.union_accounting_runs q
            WHERE q.union_id=u.id
              AND (q.status<>'complete' OR (u.earliest_period_start IS NULL
                AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week$dispatch_new$;
BEGIN
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)
 INTO definition;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure
   AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=public']::text[])
  OR md5(pg_get_functiondef('public.fn_process_weekly_accounting(uuid)'::regprocedure)) IS DISTINCT FROM '5aec6700bf043463e9db2933ca63bca1'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role'])r
    WHERE has_function_privilege(r,'public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE'))
  OR (SELECT count(*) FROM public.ca_money_rpc_registry WHERE proname='fn_process_weekly_accounting_scope' AND status='approved')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.union_accounting_runs'::regclass
    AND attname='last_scheduler_visit_at' AND atttypid='timestamptz'::regtype AND NOT attisdropped) THEN
  RAISE EXCEPTION 'standalone_timing_authority_preimage_changed';
 END IF;

 -- Reverse the three final162500 timing edits before its retained full-preimage proof.
 IF (length(definition)-length(replace(definition,$timing_new_0$        -- A source writer may have held this period lock across the deadline,
        -- maintenance announcement or a freeze change. Recheck after the lock
        -- and completion reads before creating a new financial attempt.
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        INSERT INTO public.union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,started_at)$timing_new_0$,'')))<>length($timing_new_0$        -- A source writer may have held this period lock across the deadline,
        -- maintenance announcement or a freeze change. Recheck after the lock
        -- and completion reads before creating a new financial attempt.
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        INSERT INTO public.union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,started_at)$timing_new_0$) THEN RAISE EXCEPTION 'accounting_observer_coordinator_preimage_changed';END IF;
 definition:=replace(definition,$timing_new_0$        -- A source writer may have held this period lock across the deadline,
        -- maintenance announcement or a freeze change. Recheck after the lock
        -- and completion reads before creating a new financial attempt.
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        INSERT INTO public.union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,started_at)$timing_new_0$,$timing_old_0$        INSERT INTO public.union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,started_at)$timing_old_0$);
 IF (length(definition)-length(replace(definition,$timing_new_1$          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND w.first_week<v_to
            AND v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days')) GROUP BY w.club_id$timing_new_1$,'')))<>length($timing_new_1$          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND w.first_week<v_to
            AND v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days')) GROUP BY w.club_id$timing_new_1$) THEN RAISE EXCEPTION 'accounting_observer_coordinator_preimage_changed';END IF;
 definition:=replace(definition,$timing_new_1$          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND w.first_week<v_to
            AND v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days')) GROUP BY w.club_id$timing_new_1$,$timing_old_1$          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND w.first_week<v_to
            AND v_now>=public.fn_union_accounting_run_at(v_to) GROUP BY w.club_id$timing_old_1$);
 IF (length(definition)-length(replace(definition,$timing_new_2$  IF p_union_id IS NULL THEN$timing_new_2$,'')))<>length($timing_new_2$  IF p_union_id IS NULL THEN$timing_new_2$) THEN RAISE EXCEPTION 'accounting_observer_coordinator_preimage_changed';END IF;
 definition:=replace(definition,$timing_new_2$  IF p_union_id IS NULL THEN$timing_new_2$,$timing_old_2$  IF p_union_id IS NULL AND v_now>=public.fn_union_accounting_run_at(v_to) THEN$timing_old_2$);
 -- First prove and reverse exactly the two approved continuation clauses.
 -- Timing must compose after that successor, never replace it from fcdb.
 IF length(definition)-length(replace(definition,exact_new,''))<>length(exact_new)
  OR length(definition)-length(replace(definition,dispatch_new,''))<>length(dispatch_new) THEN
  RAISE EXCEPTION 'standalone_timing_continuation_preimage_changed';END IF;
 reconstructed:=replace(replace(definition,exact_new,exact_old),dispatch_new,dispatch_old);

 -- No unmeasured final-function hash is invented. Reverse EVERY exact final
 -- fairness transform and the preceding PNL predicate, requiring exact chunk
 -- multiplicities, then compare with the previously measured J definition.
 -- Removed bytes are themselves literal preimages below; arbitrary inserted
 -- dispatch code cannot disappear from the hash check unnoticed.
 FOR change IN SELECT * FROM (VALUES
 ($fair_dispatch$  IF v_attempt_budget<1 OR NOT isfinite(v_scheduler_started) THEN
    RAISE EXCEPTION 'invalid_weekly_scheduler_budget' USING ERRCODE='22023';END IF;
  IF p_union_id IS NULL AND p_club_id IS NULL THEN
    v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);
    v_saved_started:=current_setting('app.weekly_accounting_scheduler_started',true);
    BEGIN
      FOR v_scope IN
        WITH standalone_work AS (
          SELECT s.club_id,min(public.fn_union_week_start(s.earned_at)) AS first_week
           FROM public.accounting_payable_earning_sources s WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to GROUP BY s.club_id
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
            AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
              WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
          UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
           FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date
            AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
          UNION ALL SELECT a.club_id,public.fn_union_prev_week_start(v_now) FROM public.agents a
           WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0 AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
        ), union_floors AS (
          SELECT u.id,f.earliest_period_start,CASE WHEN f.earliest_period_start IS NULL THEN public.fn_union_prev_week_start(v_now)
             WHEN public.fn_union_week_start(f.earliest_period_start)<f.earliest_period_start
              THEN public.fn_union_week_start(public.fn_union_week_start(f.earliest_period_start)+interval '8 days')
             ELSE public.fn_union_week_start(f.earliest_period_start) END AS first_week
           FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id
        ), union_work AS (
          SELECT u.id,LEAST(u.first_week,(SELECT min(q.period_start) FROM public.union_accounting_runs q
            WHERE q.union_id=u.id AND q.status<>'complete'
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week
           FROM union_floors u
        ), eligible AS (
          -- Match the exact-scope floor rounding and per-week due check. An
          -- older union backlog remains due before this Monday's new close.
          SELECT 'union'::text AS kind,w.id FROM union_work w WHERE w.first_week<v_to
           AND v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days'))
          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND w.first_week<v_to
            AND v_now>=public.fn_union_accounting_run_at(v_to) GROUP BY w.club_id
        ) SELECT e.kind,e.id,max(GREATEST(q.last_scheduler_visit_at,q.started_at)) AS last_visit
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          GROUP BY e.kind,e.id
          ORDER BY last_visit NULLS FIRST,(e.kind='union') DESC,e.id
      LOOP
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
          v_more:=true;EXIT;END IF;
        -- Transaction advisory locks are reentrant. The exact child call uses
        -- this same scheduler lock and only the remaining TOTAL attempt budget.
        PERFORM set_config('app.weekly_accounting_attempt_budget',(v_attempt_budget-v_checked)::text,true);
        PERFORM set_config('app.weekly_accounting_scheduler_started',v_scheduler_started::text,true);
        v_scope_result:=public.fn_process_weekly_accounting_scope(
          CASE WHEN v_scope.kind='union' THEN v_scope.id END,
          CASE WHEN v_scope.kind='club' THEN v_scope.id END);
        IF v_scope_result->>'skipped'='true' AND v_scope_result->>'reason'='maintenance_window' THEN
          v_more:=true;EXIT;END IF;
        IF jsonb_typeof(v_scope_result->'checked') IS DISTINCT FROM 'number'
          OR jsonb_typeof(v_scope_result->'failed') IS DISTINCT FROM 'number'
          OR jsonb_typeof(v_scope_result->'detail') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'weekly_scope_scheduler_receipt_invalid' USING ERRCODE='23514';END IF;
        v_scope_checked:=(v_scope_result->>'checked')::integer;v_scope_failed:=(v_scope_result->>'failed')::integer;
        IF v_scope_checked<0 OR v_scope_checked>v_attempt_budget-v_checked OR v_scope_failed<0
          OR v_scope_failed>v_scope_checked OR jsonb_array_length(v_scope_result->'detail')<>v_scope_checked
          OR v_scope_result->'checked' IS DISTINCT FROM to_jsonb(v_scope_checked)
          OR v_scope_result->'failed' IS DISTINCT FROM to_jsonb(v_scope_failed)
          OR v_scope_result->'success' IS DISTINCT FROM to_jsonb(v_scope_failed=0)
          OR (SELECT count(*) FROM jsonb_array_elements(v_scope_result->'detail')d WHERE d->'result'->'success' IS DISTINCT FROM 'true'::jsonb)<>v_scope_failed
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_scope_result->'detail')d
            WHERE CASE WHEN v_scope.kind='union' THEN d->>'union_id' ELSE d->>'club_id' END IS DISTINCT FROM v_scope.id::text) THEN
          RAISE EXCEPTION 'weekly_scope_scheduler_receipt_invalid' USING ERRCODE='23514';END IF;
        v_checked:=v_checked+v_scope_checked;v_failed:=v_failed+v_scope_failed;
        v_results:=v_results||(v_scope_result->'detail');v_visits:=v_visits+1;
        v_more:=v_more OR COALESCE((v_scope_result->>'more_remaining')::boolean,false);
        -- Completed/zero-work scopes must move to the back too. Reuse one real
        -- run row; never change attempts, result, started_at or finished_at.
        UPDATE public.union_accounting_runs q SET last_scheduler_visit_at=clock_timestamp()
         WHERE q.scope_kind=v_scope.kind AND q.scope_id=v_scope.id
          AND (q.period_start,q.period_end)=(SELECT r.period_start,r.period_end FROM public.union_accounting_runs r
            WHERE r.scope_kind=v_scope.kind AND r.scope_id=v_scope.id ORDER BY r.period_start DESC,r.period_end DESC LIMIT 1);
      END LOOP;
      PERFORM set_config('app.weekly_accounting_attempt_budget',COALESCE(v_saved_budget,''),true);
      PERFORM set_config('app.weekly_accounting_scheduler_started',COALESCE(v_saved_started,''),true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('app.weekly_accounting_attempt_budget',COALESCE(v_saved_budget,''),true);
      PERFORM set_config('app.weekly_accounting_scheduler_started',COALESCE(v_saved_started,''),true);
      RAISE;
    END;
    RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
      'visited_scopes',v_visits,'more_remaining',v_more,'observed_at',clock_timestamp(),'detail',v_results);
  END IF;

  FOR v_union IN SELECT u.id, f.earliest_period_start$fair_dispatch$,
 $original_dispatch$  FOR v_union IN SELECT u.id, f.earliest_period_start$original_dispatch$,1,1),
 ($fair_history$      IF clock_timestamp()-v_scheduler_started>interval '15 minutes'
        OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||v_union.id$fair_history$,
 $original_history$      PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||v_union.id$original_history$,1,2),
 ($fair_union$    SELECT LEAST(v_first,min(q.period_start)) INTO v_first
      FROM public.union_accounting_runs q WHERE q.union_id=v_union.id AND q.status<>'complete'
        AND (v_union.earliest_period_start IS NULL OR q.period_start>=v_first);
    v_from := v_first;$fair_union$,$original_union$    v_from := v_first;$original_union$,1,3),
 ($fair_club$         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
         WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
          AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
            WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
        UNION ALL SELECT rp.club_id$fair_club$,
 $original_club$         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT rp.club_id$original_club$,1,4),
 ($fair_declarations$  v_attempt_budget integer := LEAST(8,COALESCE(NULLIF(current_setting('app.weekly_accounting_attempt_budget',true),'')::integer,8));
  v_scheduler_started timestamptz := LEAST(clock_timestamp(),COALESCE(NULLIF(current_setting('app.weekly_accounting_scheduler_started',true),'')::timestamptz,clock_timestamp()));
  v_scope record;v_scope_result jsonb;v_scope_checked integer;v_scope_failed integer;
  v_saved_budget text;v_saved_started text;v_more boolean:=false;v_visits integer:=0;
  v_stage2 jsonb;$fair_declarations$,$original_declarations$  v_stage2 jsonb;$original_declarations$,1,5),
 ($fair_budget$v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'$fair_budget$,
 $original_budget$v_checked>=8 OR clock_timestamp()-v_now>interval '15 minutes'$original_budget$,2,6),
 ($pnl_skip$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
        AND public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' THEN$pnl_skip$,
 $original_skip$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3' THEN$original_skip$,1,7)
 ) AS reversals(installed_text,previous_text,occurrences,ordinal) ORDER BY ordinal
 LOOP
  IF length(reconstructed)-length(replace(reconstructed,change.installed_text,''))
    <> length(change.installed_text)*change.occurrences THEN
   RAISE EXCEPTION 'standalone_timing_function_preimage_changed';
  END IF;
  reconstructed:=replace(reconstructed,change.installed_text,change.previous_text);
 END LOOP;
 IF md5(reconstructed) IS DISTINCT FROM '63f8248cd6d804f450a0b8f0fbc05e77' THEN
  RAISE EXCEPTION 'standalone_timing_function_preimage_changed';END IF;

END $coordinator_preimage$;
DO $canonical$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_mark_scope_accounting_settled(text,uuid,timestamptz,timestamptz)'::regprocedure AND md5(prosrc)='cca3f07d57d1539d2d0dc442d003f1c5' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid='public.fn_mark_scope_accounting_settled(text,uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres']::text[] THEN RAISE EXCEPTION 'accounting_observer_canonical_writer_changed' USING DETAIL='fn_mark_scope_accounting_settled(text,uuid,timestamptz,timestamptz)';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure AND md5(prosrc)='b056cb5aaf104e354871549cf642674f' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']) OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid='public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM ARRAY['postgres=X/postgres']::text[] THEN RAISE EXCEPTION 'accounting_observer_canonical_writer_changed' USING DETAIL='fn_union_settlement_cascade(uuid,timestamptz,timestamptz)';END IF;
END$canonical$;
CREATE OR REPLACE FUNCTION public.fn_open_settlement_period(p_club_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION 'automatic_weekly_accounting_only' USING ERRCODE='55000';END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_set_settlement_period_status(p_period_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION 'automatic_weekly_accounting_only' USING ERRCODE='55000';END;
$function$;
CREATE OR REPLACE FUNCTION public.get_current_settlement_period()
 RETURNS TABLE(id uuid, period_start timestamp with time zone, period_end timestamp with time zone, status text, total_rake numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN RAISE EXCEPTION 'automatic_weekly_accounting_only' USING ERRCODE='55000';END;
$function$;
CREATE OR REPLACE FUNCTION public.get_current_settlement_period(p_club_id uuid)
 RETURNS TABLE(id uuid, club_id uuid, union_id uuid, scope text, period_number integer, year integer, period_start timestamp with time zone, period_end timestamp with time zone, status text, total_rake numeric, total_bbj numeric, total_player_winnings numeric, total_player_losses numeric, total_hands_dealt bigint, settled_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION 'automatic_weekly_accounting_only' USING ERRCODE='55000';END;
$function$;
REVOKE TRIGGER,REFERENCES ON public.settlement_periods FROM PUBLIC,anon,authenticated;
DO $columns$ DECLARE col text;BEGIN FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='public.settlement_periods'::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE REFERENCES(%I) ON public.settlement_periods FROM PUBLIC,anon,authenticated',col);END LOOP;END$columns$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES ('fn_open_settlement_period','closed','Retired browser period writer: explicit refusal; only canonical accounting owns periods.'),('fn_set_settlement_period_status','closed','Retired browser completion writer: explicit refusal, never a payment or completion certificate.'),('get_current_settlement_period','closed','Both legacy overloads retired: no implicit period creation/global lookup or club-member union money projection. Use exact scoped status observation.');

CREATE FUNCTION public.fn_accounting_run_observation_v1(p_expected_actor_id uuid,p_scope_kind text,p_scope_id uuid,
 p_period_start timestamptz,p_period_end timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public SET TimeZone='UTC' SET DateStyle='ISO,YMD'
 SET statement_timeout='10s' SET lock_timeout='2s' AS $function$
DECLARE actor uuid:=auth.uid();observed timestamptz:=statement_timestamp();expected_run timestamptz;
 r public.union_accounting_runs%ROWTYPE;answer jsonb;result_start timestamptz;result_end timestamptz;
 start_text text;end_text text;period_count integer;settled_count integer;
BEGIN
 IF actor IS NULL OR p_expected_actor_id IS NULL OR actor='00000000-0000-0000-0000-000000000000'::uuid
  OR p_expected_actor_id='00000000-0000-0000-0000-000000000000'::uuid OR actor IS DISTINCT FROM p_expected_actor_id
 THEN RAISE EXCEPTION 'accounting_observation_account_changed' USING ERRCODE='42501';END IF;
 IF p_scope_kind IS NULL OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL OR p_scope_id='00000000-0000-0000-0000-000000000000'::uuid
 THEN RAISE EXCEPTION 'invalid_accounting_observation_scope' USING ERRCODE='22023';END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'invalid_accounting_observation_week' USING ERRCODE='22023';END IF;
 -- No broad club-view, service-role or owner-session shortcut is used here.
 IF p_scope_kind='union' THEN
  IF public.ca_can_oversee_union(p_scope_id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_scope_id)
  THEN RAISE EXCEPTION 'accounting_observation_not_authorized' USING ERRCODE='42501';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.fn_accounting_party_users('club',p_scope_id)p WHERE p.user_id=actor)
   OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_scope_id AND c.is_union IS NOT TRUE)
  THEN RAISE EXCEPTION 'accounting_observation_not_authorized' USING ERRCODE='42501';END IF;
 END IF;
 expected_run:=public.fn_union_accounting_run_at(p_period_end);
 answer:=jsonb_build_object('contract_version',1,'actor_user_id',actor,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'period_start',p_period_start,'period_end',p_period_end,'observed_at',observed,'expected_run_at',expected_run,
  'record_found',false,'state',CASE WHEN p_scope_kind='union' THEN 'no_recorded_run' ELSE 'unavailable' END,
  'recorded_scheduled_at',NULL,'attempts',NULL,'started_at',NULL,'finished_at',NULL,'posted',false);
 -- An absent standalone journal cannot establish that a union-managed club's
 -- accounting did not run. Never infer historical applicability from clubs.union_id.
 SELECT * INTO r FROM public.union_accounting_runs q WHERE q.scope_kind=p_scope_kind AND q.scope_id=p_scope_id
  AND q.period_start=p_period_start AND q.period_end=p_period_end;
 IF NOT FOUND THEN RETURN answer;END IF;
 answer:=answer||jsonb_build_object('record_found',true,'state','unavailable');
 IF r.scheduled_at IS DISTINCT FROM expected_run OR NOT isfinite(r.scheduled_at)
  OR r.attempts IS NULL OR r.attempts<1 OR r.started_at IS NULL OR NOT isfinite(r.started_at)
  OR r.started_at<r.scheduled_at OR r.started_at>observed OR jsonb_typeof(r.result) IS DISTINCT FROM 'object'
 THEN RETURN answer;END IF;
 IF r.status='running' THEN
  -- A recorded running row is not a heartbeat or proof of a live process.
  IF r.finished_at IS NOT NULL THEN RETURN answer;END IF;
  RETURN answer||jsonb_build_object('state','running','recorded_scheduled_at',r.scheduled_at,'attempts',r.attempts,
   'started_at',r.started_at,'finished_at',NULL);
 END IF;
 IF r.finished_at IS NULL OR NOT isfinite(r.finished_at) OR r.finished_at<r.started_at OR r.finished_at>observed
 THEN RETURN answer;END IF;
 IF r.status='failed' THEN
  IF r.result->'success' IS DISTINCT FROM 'false'::jsonb THEN RETURN answer;END IF;
  RETURN answer||jsonb_build_object('state','incomplete','recorded_scheduled_at',r.scheduled_at,'attempts',r.attempts,
   'started_at',r.started_at,'finished_at',r.finished_at);
 END IF;
 IF r.status IS DISTINCT FROM 'complete' OR r.result->'success' IS DISTINCT FROM 'true'::jsonb
  OR r.result->'accounting_version' IS DISTINCT FROM '3'::jsonb
 THEN RETURN answer;END IF;
 IF (p_scope_kind='union' AND (jsonb_typeof(r.result->'union_id') IS DISTINCT FROM 'string'
      OR r.result->>'union_id' IS DISTINCT FROM p_scope_id::text))
  OR (p_scope_kind='club' AND (r.result->>'scope_kind' IS DISTINCT FROM 'club'
      OR jsonb_typeof(r.result->'scope_id') IS DISTINCT FROM 'string' OR r.result->>'scope_id' IS DISTINCT FROM p_scope_id::text))
 THEN RETURN answer;END IF;
 start_text:=r.result->>'period_start';end_text:=r.result->>'period_end';
 IF jsonb_typeof(r.result->'period_start') IS DISTINCT FROM 'string' OR jsonb_typeof(r.result->'period_end') IS DISTINCT FROM 'string'
  OR length(start_text)>64 OR length(end_text)>64
  OR start_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  OR end_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
 THEN RETURN answer;END IF;
 BEGIN result_start:=start_text::timestamptz;result_end:=end_text::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN answer;END;
 IF NOT isfinite(result_start) OR NOT isfinite(result_end) OR result_start IS DISTINCT FROM p_period_start OR result_end IS DISTINCT FROM p_period_end
 THEN RETURN answer;END IF;
 SELECT count(*),count(*) FILTER(WHERE sp.status IN('settled','closed')) INTO period_count,settled_count
 FROM public.settlement_periods sp WHERE sp.start_at=p_period_start AND sp.end_at=p_period_end
  AND sp.club_id IS NOT DISTINCT FROM CASE WHEN p_scope_kind='club' THEN p_scope_id END
  AND sp.union_id IS NOT DISTINCT FROM CASE WHEN p_scope_kind='union' THEN p_scope_id END;
 IF period_count<>1 OR settled_count<>1 THEN RETURN answer;END IF;
 RETURN answer||jsonb_build_object('state','posted','posted',true,'recorded_scheduled_at',r.scheduled_at,'attempts',r.attempts,
  'started_at',r.started_at,'finished_at',r.finished_at);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_run_observation_v1(uuid,text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_run_observation_v1(uuid,text,uuid,timestamptz,timestamptz) TO authenticated,service_role;

DO $authority$ DECLARE who text;col text;sig text;BEGIN
 FOREACH who IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_table_privilege(who,'public.settlement_periods','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN')
  THEN RAISE EXCEPTION 'legacy_period_table_authority_remaining' USING DETAIL=who;END IF;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='public.settlement_periods'::regclass AND attnum>0 AND NOT attisdropped LOOP
   IF has_column_privilege(who,'public.settlement_periods',col,'INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'legacy_period_column_authority_remaining' USING DETAIL=who||':'||col;END IF;
  END LOOP;
 END LOOP;
 FOREACH sig IN ARRAY ARRAY['public.fn_open_settlement_period(uuid)','public.fn_set_settlement_period_status(uuid,text)',
  'public.get_current_settlement_period()','public.get_current_settlement_period(uuid)',
  'public.fn_accounting_run_observation_v1(uuid,text,uuid,timestamptz,timestamptz)'] LOOP
  IF has_function_privilege('anon',sig,'EXECUTE') OR NOT has_function_privilege('authenticated',sig,'EXECUTE')
   OR NOT has_function_privilege('service_role',sig,'EXECUTE')
  THEN RAISE EXCEPTION 'accounting_observer_function_access_changed' USING DETAIL=sig;END IF;
 END LOOP;
END$authority$;
COMMIT;
