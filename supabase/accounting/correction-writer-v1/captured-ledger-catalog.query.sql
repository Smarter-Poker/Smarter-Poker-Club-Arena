BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='2s';
WITH selected AS (
 SELECT c.*,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('chip_ledger','chip_ledger_idem')
)
SELECT jsonb_build_object(
 'captured_at',clock_timestamp()::text,'transaction_read_only',current_setting('transaction_read_only'),
 'transaction_isolation',current_setting('transaction_isolation'),'statement_timeout',current_setting('statement_timeout'),
 'lock_timeout',current_setting('lock_timeout'),'server_version',current_setting('server_version'),
 'relations',(SELECT jsonb_agg(jsonb_build_object(
  'schema',c.nspname,'name',c.relname,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,
  'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'partition',c.relispartition,
  'partition_key',CASE WHEN c.relkind='p' THEN pg_get_partkeydef(c.oid) END,
  'partition_bound',pg_get_expr(c.relpartbound,c.oid),'replica_identity',c.relreplident,'acl',c.relacl,'options',c.reloptions,
  'columns',(SELECT jsonb_agg(jsonb_build_object(
    'name',a.attname,'ordinal',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
    'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,
    'acl',a.attacl,'collation',CASE WHEN a.attcollation<>0 THEN a.attcollation::regcollation::text END,
    'effective_privileges',(SELECT jsonb_object_agg(api,jsonb_build_object(
      'SELECT',has_column_privilege(api,c.oid,a.attnum,'SELECT'),
      'INSERT',has_column_privilege(api,c.oid,a.attnum,'INSERT'),
      'UPDATE',has_column_privilege(api,c.oid,a.attnum,'UPDATE'),
      'REFERENCES',has_column_privilege(api,c.oid,a.attnum,'REFERENCES')))
      FROM unnest(ARRAY['anon','authenticated','service_role'])api))
    ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,
    'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'deferrable',k.condeferrable,
    'initially_deferred',k.condeferred,'columns',k.conkey,'foreign_columns',k.confkey,
    'referenced_relation',CASE WHEN k.confrelid<>0 THEN k.confrelid::regclass::text END)
    ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ci.relname,'definition',pg_get_indexdef(i.indexrelid),
    'owner',pg_get_userbyid(ci.relowner),'kind',ci.relkind,'unique',i.indisunique,'primary',i.indisprimary,
    'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'immediate',i.indimmediate,
    'replica_identity',i.indisreplident,'clustered',i.indisclustered,'nulls_not_distinct',i.indnullsnotdistinct)
    ORDER BY ci.relname) FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),
    'enabled',t.tgenabled,'internal',t.tgisinternal,'type',t.tgtype,'function',t.tgfoid::regprocedure::text,
    'function_definition',pg_get_functiondef(t.tgfoid),'function_definition_md5',md5(pg_get_functiondef(t.tgfoid)),
    'function_body_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl,
    'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred)
    ORDER BY t.tgname) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=c.oid),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) FROM pg_policies p WHERE p.schemaname=c.nspname AND p.tablename=c.relname),
  'inheritance',(SELECT jsonb_agg(jsonb_build_object('parent',i.inhparent::regclass::text,'child',i.inhrelid::regclass::text,'sequence',i.inhseqno)
    ORDER BY i.inhparent::regclass::text,i.inhrelid::regclass::text) FROM pg_inherits i WHERE c.oid IN(i.inhparent,i.inhrelid)),
  'effective_privileges',(SELECT jsonb_object_agg(api,jsonb_build_object(
    'table',(SELECT jsonb_object_agg(priv,has_table_privilege(api,c.oid,priv)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])priv),
    'any_column',(SELECT jsonb_object_agg(priv,has_any_column_privilege(api,c.oid,priv)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES'])priv)))
    FROM unnest(ARRAY['anon','authenticated','service_role'])api)
 ) ORDER BY c.relname) FROM selected c),
 'roles',(SELECT jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,'inherit',rolinherit,'create_role',rolcreaterole,'create_db',rolcreatedb,
  'login',rolcanlogin,'replication',rolreplication,'bypass_rls',rolbypassrls,'config',rolconfig) ORDER BY rolname) FROM pg_roles),
 'memberships',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'grantor',g.rolname,
  'admin',a.admin_option,'inherit',a.inherit_option,'set',a.set_option) ORDER BY r.rolname,m.rolname,g.rolname)
  FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor),
 'default_acl',(SELECT jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(d.defaclrole),
  'schema',CASE WHEN d.defaclnamespace=0 THEN NULL ELSE d.defaclnamespace::regnamespace::text END,
  'object_type',d.defaclobjtype,'acl',d.defaclacl) ORDER BY pg_get_userbyid(d.defaclrole),d.defaclnamespace::regnamespace::text,d.defaclobjtype)
  FROM pg_default_acl d WHERE d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace)
) AS catalog;
ROLLBACK;

