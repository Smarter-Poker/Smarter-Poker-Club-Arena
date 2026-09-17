\set ON_ERROR_STOP on
-- Post-candidate isolated observation only. This is a NEW capture, not a
-- replacement for any of the29 original metadata captures. No financial rows.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='2s';
SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO,YMD';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
  OR to_regclass('public.ca_correction_request_intents_v1') IS NULL
 THEN RAISE EXCEPTION 'isolated installed correction writer authority required';END IF;
END$guard$;
WITH target AS(SELECT c.* FROM pg_class c WHERE c.oid='public.ca_correction_request_intents_v1'::regclass),
api_roles AS(SELECT oid,rolname,rolsuper,rolbypassrls,rolinherit FROM pg_roles),
functions AS(SELECT p.* FROM pg_proc p WHERE p.oid IN(
 'public.fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)'::regprocedure,
 'public.ca_correction_intent_immutable_v1()'::regprocedure))
SELECT jsonb_build_object(
 'capture','component36_post_fixture_authority','observed_at',clock_timestamp(),
 'context',jsonb_build_object('current_user',current_user,'session_user',session_user,
  'server_version',current_setting('server_version'),'replication_role',current_setting('session_replication_role'),
  'transaction_read_only',current_setting('transaction_read_only')),
 'relation',(SELECT jsonb_build_object('name',c.oid::regclass::text,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
  'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions,'acl',c.relacl,
  'columns',(SELECT jsonb_agg(jsonb_build_object('number',a.attnum,'name',a.attname,
   'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
   'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'validated',k.convalidated,
   'deferrable',k.condeferrable,'deferred',k.condeferred,'definition',pg_get_constraintdef(k.oid,true)) ORDER BY k.conname),'[]'::jsonb)
   FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,
   'definition',pg_get_indexdef(i.indexrelid),'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready) ORDER BY i.indexrelid::regclass::text),'[]'::jsonb)
   FROM pg_index i WHERE i.indrelid=c.oid),
  'policies',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,
   'command',p.polcmd,'roles',p.polroles,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname),'[]'::jsonb)
   FROM pg_policy p WHERE p.polrelid=c.oid),
  'triggers',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'internal',t.tgisinternal,
   'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred,'definition',pg_get_triggerdef(t.oid,true),
   'function',t.tgfoid::regprocedure::text) ORDER BY t.tgname),'[]'::jsonb) FROM pg_trigger t WHERE t.tgrelid=c.oid)
 ) FROM target c),
 'effective_table_privileges',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'superuser',r.rolsuper,
  'bypass_rls',r.rolbypassrls,'inherits',r.rolinherit,'privilege',privilege,'allowed',has_table_privilege(r.oid,c.oid,privilege)) ORDER BY r.rolname,privilege)
  FROM api_roles r CROSS JOIN target c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) rights(privilege)),
 'effective_column_privileges',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'column',a.attname,
  'privilege',privilege,'allowed',has_column_privilege(r.oid,a.attrelid,a.attnum,privilege)) ORDER BY r.rolname,a.attnum,privilege)
  FROM api_roles r CROSS JOIN target c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) rights(privilege)),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
  'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl,'volatility',p.provolatile,'parallel',p.proparallel,
  'definition',pg_get_functiondef(p.oid),'definition_md5',md5(pg_get_functiondef(p.oid)),'body_md5',md5(p.prosrc),
  'effective_execute',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'allowed',has_function_privilege(r.oid,p.oid,'EXECUTE')) ORDER BY r.rolname) FROM api_roles r)) ORDER BY p.oid::regprocedure::text) FROM functions p),
 'raw_effective_acl',(SELECT COALESCE(jsonb_agg(jsonb_build_object('object',object_name,'grantor',pg_get_userbyid(x.grantor),
  'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'privilege',x.privilege_type,'grantable',x.is_grantable)
  ORDER BY object_name,x.grantee,x.privilege_type),'[]'::jsonb) FROM(
   SELECT c.oid::regclass::text object_name,COALESCE(c.relacl,acldefault('r',c.relowner)) acl FROM target c
   UNION ALL SELECT p.oid::regprocedure::text,COALESCE(p.proacl,acldefault('f',p.proowner)) FROM functions p
  ) objects CROSS JOIN LATERAL aclexplode(objects.acl) x));
ROLLBACK;
