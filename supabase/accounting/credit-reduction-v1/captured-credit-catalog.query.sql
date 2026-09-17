BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='2s';
WITH selected AS (
 SELECT c.*,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('agents','credit_assignments')
), known_names(name) AS (VALUES
 ('fn_admin_update_agent'),('fn_guard_agent_agreement'),('fn_club_set_member_role'),('fn_review_credit_request'),
 ('fn_agent_wallet_send'),('fn_process_credit_invoice_payment'),('fn_pay_credit_invoice_from_wallet'),
 ('fn_apply_credit_payment'),('sync_agent_wallet_columns'),('guard_agent_wallet_direct_update'),('fn_notify_credit_request')
), function_candidates AS (
 SELECT p.oid,
  EXISTS(SELECT 1 FROM known_names k WHERE k.name=p.proname) AS named_target,
  EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN(SELECT oid FROM selected) AND NOT t.tgisinternal AND t.tgfoid=p.oid) AS target_trigger,
  (p.prosrc ~* '\m(update|insert[[:space:]]+into|delete[[:space:]]+from)[[:space:]]+(public\.)?agents\M'
   AND p.prosrc ~* '\m(credit_limit|credit_used|is_prepaid|parent_agent_id)\M') AS direct_credit_source_match
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind='f' AND (
  EXISTS(SELECT 1 FROM known_names k WHERE k.name=p.proname)
  OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN(SELECT oid FROM selected) AND NOT t.tgisinternal AND t.tgfoid=p.oid)
  OR (p.prosrc ~* '\m(update|insert[[:space:]]+into|delete[[:space:]]+from)[[:space:]]+(public\.)?agents\M'
   AND p.prosrc ~* '\m(credit_limit|credit_used|is_prepaid|parent_agent_id)\M'))
), bounded_functions AS (
 SELECT * FROM function_candidates ORDER BY named_target DESC,target_trigger DESC,oid LIMIT 64
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
 'incoming_foreign_keys',(SELECT jsonb_agg(jsonb_build_object('table',k.conrelid::regclass::text,'name',k.conname,
   'referenced_relation',k.confrelid::regclass::text,'definition',pg_get_constraintdef(k.oid,true),
   'validated',k.convalidated,'deferrable',k.condeferrable,'initially_deferred',k.condeferred)
   ORDER BY k.conrelid::regclass::text,k.conname) FROM pg_constraint k
   WHERE k.contype='f' AND k.confrelid IN(SELECT oid FROM selected)),
 'function_candidate_count',(SELECT count(*) FROM function_candidates),
 'function_limit',64,
 'missing_named_functions',(SELECT jsonb_agg(k.name ORDER BY k.name) FROM known_names k WHERE NOT EXISTS(
   SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=k.name AND p.prokind='f')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
   'identity_arguments',pg_get_function_identity_arguments(p.oid),'arguments',pg_get_function_arguments(p.oid),
   'result',pg_get_function_result(p.oid),'name',p.proname,'owner',pg_get_userbyid(p.proowner),
   'language',l.lanname,'kind',p.prokind,'security_definer',p.prosecdef,'strict',p.proisstrict,'leakproof',p.proleakproof,
   'volatility',p.provolatile,'parallel',p.proparallel,'config',p.proconfig,'acl',p.proacl,
   'definition',pg_get_functiondef(p.oid),'definition_md5',md5(pg_get_functiondef(p.oid)),
   'body_md5',md5(p.prosrc),'named_target',b.named_target,'target_trigger',b.target_trigger,
   'direct_credit_source_match',b.direct_credit_source_match,
   'effective_execute',(SELECT jsonb_object_agg(api,has_function_privilege(api,p.oid,'EXECUTE'))
     FROM unnest(ARRAY['anon','authenticated','service_role'])api),
   'direct_function_dependencies',(SELECT jsonb_agg(jsonb_build_object('signature',d.refobjid::regprocedure::text,'type',d.deptype)
     ORDER BY d.refobjid::regprocedure::text) FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid
       AND d.refclassid='pg_proc'::regclass),
   'direct_relation_dependencies',(SELECT jsonb_agg(jsonb_build_object('relation',d.refobjid::regclass::text,'type',d.deptype)
     ORDER BY d.refobjid::regclass::text) FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid
       AND d.refclassid='pg_class'::regclass)) ORDER BY p.oid::regprocedure::text)
   FROM bounded_functions b JOIN pg_proc p ON p.oid=b.oid JOIN pg_language l ON l.oid=p.prolang),
 'source_search_limit','Static public PL/pgSQL body token search; aliases, dynamic SQL, indirect and external callers are not exhaustively proven.',
 'missing_relations',(SELECT jsonb_agg(v.name) FROM (VALUES('agents'),('credit_assignments'))v(name)
   WHERE NOT EXISTS(SELECT 1 FROM selected s WHERE s.relname=v.name))
) AS catalog;
ROLLBACK;
