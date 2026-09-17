-- Fixture-only readback after accepted full activation, before test seeds.
-- Full definitions also reside in the independently retained schema dump.
\set ON_ERROR_STOP on
SELECT jsonb_build_object(
 'scope','Actual isolated fixture authority after full candidate; not production acceptance',
 'postgresql_version',current_setting('server_version'),
 'functions',(SELECT jsonb_agg(jsonb_build_object(
   'signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
   'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl,
   'definition_md5',md5(pg_get_functiondef(p.oid)),'source_md5',md5(p.prosrc),
   'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
   'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
   'service_execute',has_function_privilege('service_role',p.oid,'EXECUTE')
  ) ORDER BY n.nspname,p.proname,p.oid::regprocedure::text)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN('public','auth','operational_source_intake') AND p.prokind IN('f','p')),
 'period_tables',(SELECT jsonb_agg(jsonb_build_object(
   'table',c.oid::regclass::text,'owner',pg_get_userbyid(c.relowner),
   'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
   -- Raw ACLs alone do not expose inherited/predefined-role authority.
   -- Preserve them and record each API role's effective table/column rights.
   'effective_privileges',(SELECT jsonb_object_agg(api_role,jsonb_build_object(
     'table',(SELECT jsonb_object_agg(privilege_name,has_table_privilege(api_role,c.oid,privilege_name))
       FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS tp(privilege_name)),
     'any_column',(SELECT jsonb_object_agg(privilege_name,has_any_column_privilege(api_role,c.oid,privilege_name))
       FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS cp(privilege_name))
    )) FROM unnest(ARRAY['anon','authenticated','service_role']) AS api(api_role)),
   'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,
     'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
     'definition',pg_get_constraintdef(k.oid)) ORDER BY k.conname)
     FROM pg_constraint k WHERE k.conrelid=c.oid),
   'indexes',(SELECT jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,
     'valid',i.indisvalid,'ready',i.indisready,'definition',pg_get_indexdef(i.indexrelid))
     ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
   'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,
     'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname)
     FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
   'columns',(SELECT jsonb_agg(jsonb_build_object('column',a.attname,'acl',a.attacl,
     'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
     'identity',a.attidentity,'generated',a.attgenerated,
     'default',(SELECT pg_get_expr(ad.adbin,ad.adrelid) FROM pg_attrdef ad WHERE ad.adrelid=a.attrelid AND ad.adnum=a.attnum))
     ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
  ) ORDER BY c.relname) FROM pg_class c
  WHERE c.oid IN('public.rakeback_periods'::regclass,'public.rakeback_period_payouts'::regclass,
   'public.settlement_invoices'::regclass,'public.accounting_invoice_deliveries'::regclass,
   'public.social_messages'::regclass,'public.social_conversations'::regclass,
   'public.notifications'::regclass,'public.notification_preferences'::regclass,'public.push_subscriptions'::regclass,
   'public.credit_requests'::regclass,'public.cashout_requests'::regclass,
   'public.chip_escrow'::regclass,'public.accounting_cashier_events'::regclass,
   'public.accounting_correction_documents'::regclass,
   'public.settlement_periods'::regclass,'public.union_accounting_runs'::regclass,
   'public.engine_alerts'::regclass,'public.engine_alert_delivery_receipts'::regclass,
   'public.financial_alerts'::regclass,'public.ca_drift_incidents'::regclass,
   'public.operational_alert_events'::regclass,
   'operational_source_intake.snapshots'::regclass,'operational_source_intake.deliveries'::regclass)),
 'direct_intake_schema',(SELECT jsonb_build_object('name',n.nspname,
   'owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl,
   'effective_privileges',(SELECT jsonb_object_agg(api_role,jsonb_build_object(
     'usage',has_schema_privilege(api_role,n.oid,'USAGE'),
     'create',has_schema_privilege(api_role,n.oid,'CREATE')))
     FROM unnest(ARRAY['anon','authenticated','service_role']) api(api_role)))
   FROM pg_namespace n WHERE n.nspname='operational_source_intake'),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.tablename,p.policyname)
   FROM pg_policies p WHERE (p.schemaname='public'
   AND p.tablename IN('rakeback_periods','rakeback_period_payouts','settlement_invoices',
    'accounting_invoice_deliveries','social_messages','social_conversations',
    'notifications','notification_preferences','push_subscriptions','credit_requests','cashout_requests','chip_escrow','accounting_cashier_events','accounting_correction_documents','settlement_periods','union_accounting_runs',
    'engine_alerts','engine_alert_delivery_receipts','financial_alerts','ca_drift_incidents','operational_alert_events'))
   OR p.schemaname='operational_source_intake'),
 'cron_jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY j.jobid) FROM cron.job j),
 'money_registry',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.proname)
   FROM public.ca_money_rpc_registry r)
)::text;
