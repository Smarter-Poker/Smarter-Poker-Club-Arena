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
  WHERE n.nspname IN('public','auth') AND p.prokind IN('f','p')),
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
   'columns',(SELECT jsonb_agg(jsonb_build_object('column',a.attname,'acl',a.attacl)
     ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
  ) ORDER BY c.relname) FROM pg_class c
  WHERE c.oid IN('public.rakeback_periods'::regclass,'public.rakeback_period_payouts'::regclass,
   'public.settlement_invoices'::regclass,'public.accounting_invoice_deliveries'::regclass,
   'public.social_messages'::regclass,'public.social_conversations'::regclass,
   'public.notifications'::regclass,'public.notification_preferences'::regclass,'public.push_subscriptions'::regclass,
   'public.credit_requests'::regclass,'public.cashout_requests'::regclass,
   'public.chip_escrow'::regclass,'public.accounting_cashier_events'::regclass,
   'public.accounting_correction_documents'::regclass,
   'public.settlement_periods'::regclass,'public.union_accounting_runs'::regclass)),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.tablename,p.policyname)
   FROM pg_policies p WHERE p.schemaname='public'
   AND p.tablename IN('rakeback_periods','rakeback_period_payouts','settlement_invoices',
    'accounting_invoice_deliveries','social_messages','social_conversations',
    'notifications','notification_preferences','push_subscriptions','credit_requests','cashout_requests','chip_escrow','accounting_cashier_events','accounting_correction_documents','settlement_periods','union_accounting_runs')),
 'cron_jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY j.jobid) FROM cron.job j),
 'money_registry',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.proname)
   FROM public.ca_money_rpc_registry r)
)::text;
