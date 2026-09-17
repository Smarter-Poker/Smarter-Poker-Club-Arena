\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Read-only post-candidate catalog artifact, never a
-- replacement for captured original metadata or proof of live installation.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='2s';
SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO,YMD';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR to_regclass('public.accounting_credit_reduction_operations_v1') IS NULL
  OR to_regclass('public.accounting_credit_reduction_retirements_v1') IS NULL
  OR to_regclass('public.accounting_credit_change_documents_v1') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.agents'::regclass
   AND attname='credit_control_revision' AND attnum>0 AND NOT attisdropped)
 THEN RAISE EXCEPTION 'isolated complete credit authority required';END IF;
END$guard$;
WITH relations AS(SELECT c.* FROM pg_class c WHERE c.oid IN('public.agents'::regclass,
 'public.credit_assignments'::regclass,'public.accounting_credit_reduction_operations_v1'::regclass,
 'public.accounting_credit_reduction_retirements_v1'::regclass,'public.accounting_credit_change_documents_v1'::regclass)),
roles AS(SELECT oid,rolname,rolsuper,rolbypassrls,rolinherit FROM pg_roles),
functions AS(SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 AND (p.proname ~ '^fn_(agent_credit_reduction|reduce_agent_credit|retire_agent_credit_reduction|credit_reduction|agent_credit_control_revision|accounting_credit_change|accounting_credit_reduction)'
 OR p.proname IN('fn_admin_update_agent','fn_club_set_member_role','fn_assign_agent_to_super_agent','fn_ensure_agent_row',
  'fn_agent_wallet_send','fn_agent_wallet_send_phase2_core_20260831','fn_agent_wallet_send_core_20260830',
  'fn_cashier_cashout_transition','fn_accounting_invoice_immutable','fn_accounting_document_immutable',
  'fn_deliver_accounting_invoice','fn_mirror_notification_to_push_outbox','fn_messenger_message_page','fn_messenger_search_messages','fn_messenger_invoice_visible_to')))
SELECT jsonb_build_object('capture','credit_reduction_post_fixture_authority','observed_at',clock_timestamp(),
 'context',jsonb_build_object('current_user',current_user,'session_user',session_user,'database',current_database(),
  'server_version',current_setting('server_version'),'replication_role',current_setting('session_replication_role'),
  'transaction_read_only',current_setting('transaction_read_only')),
 'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,'owner',pg_get_userbyid(c.relowner),
  'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl,'options',c.reloptions,
  'columns',(SELECT jsonb_agg(jsonb_build_object('number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl,
   'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a
   LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'validated',k.convalidated,
   'deferrable',k.condeferrable,'deferred',k.condeferred,'definition',pg_get_constraintdef(k.oid,true)) ORDER BY k.conname),'[]'::jsonb)
   FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,'definition',pg_get_indexdef(i.indexrelid),
   'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready) ORDER BY i.indexrelid::regclass::text),'[]'::jsonb) FROM pg_index i WHERE i.indrelid=c.oid),
  'policies',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,
   'roles',p.polroles,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname),'[]'::jsonb)
   FROM pg_policy p WHERE p.polrelid=c.oid),
  'triggers',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'internal',t.tgisinternal,
   'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred,'definition',pg_get_triggerdef(t.oid,true),
   'function',t.tgfoid::regprocedure::text) ORDER BY t.tgname),'[]'::jsonb) FROM pg_trigger t WHERE t.tgrelid=c.oid)
 ) ORDER BY c.oid::regclass::text) FROM relations c),
 'table_access',(SELECT jsonb_agg(jsonb_build_object('relation',c.oid::regclass::text,'role',r.rolname,
  'superuser',r.rolsuper,'bypass_rls',r.rolbypassrls,'inherits',r.rolinherit,'privilege',v,'allowed',has_table_privilege(r.oid,c.oid,v))
  ORDER BY c.oid::regclass::text,r.rolname,v) FROM relations c CROSS JOIN roles r
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])v),
 'column_access',(SELECT jsonb_agg(jsonb_build_object('relation',c.oid::regclass::text,'column',a.attname,'role',r.rolname,
  'privilege',v,'allowed',has_column_privilege(r.oid,c.oid,a.attnum,v)) ORDER BY c.oid::regclass::text,a.attnum,r.rolname,v)
  FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN roles r
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES'])v),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
  'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl,'volatility',p.provolatile,'parallel',p.proparallel,
  'definition',pg_get_functiondef(p.oid),'definition_md5',md5(pg_get_functiondef(p.oid)),'body_md5',md5(p.prosrc),
  'effective_execute',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'allowed',has_function_privilege(r.oid,p.oid,'EXECUTE'))
   ORDER BY r.rolname) FROM roles r)) ORDER BY p.oid::regprocedure::text) FROM functions p));
ROLLBACK;
