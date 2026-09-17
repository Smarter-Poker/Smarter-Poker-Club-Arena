-- SELECT only. Run through the already approved bounded read-only connector.
-- Catalog closure only for the missing genuine post-commit delegate and owner hand writer.
-- No history, pending-addon, player or money rows are returned; no business call.
-- Caller supplies its existing read-only transaction/statement deadline.
WITH selected AS (
  SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname IN
     ('table_pending_addons')
), functions AS (
  SELECT p.* FROM pg_proc p WHERE p.oid IN (
    SELECT t.tgfoid FROM pg_trigger t JOIN selected c ON c.oid=t.tgrelid
     WHERE NOT t.tgisinternal
    UNION SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prokind='f' AND p.proname IN
        ('fn_ca_process_hand_post_commit_obligations','fn_ca_insert_hand_with_awards',
         'bbj_record_contribution','promo_apply_playthrough',
         'record_insurance_transaction','resolve_pending_addon')
  )
), packet AS (
  SELECT jsonb_build_object(
    'observed_at',clock_timestamp(),
    'server_version_num',current_setting('server_version_num'),
    'hash_domain','md5(pg_get_functiondef(oid))',
    'requested_relations',jsonb_build_array('table_pending_addons'),
    'relations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
      'acl',c.relacl::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object(
          'name',a.attname,'ordinal',a.attnum,'type',format_type(a.atttypid,a.atttypmod),
          'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
          'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d
          ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object(
          'name',k.conname,'type',k.contype,'definition',pg_get_constraintdef(k.oid,true),
          'validated',k.convalidated,'deferrable',k.condeferrable,
          'deferred',k.condeferred) ORDER BY k.conname)
        FROM pg_constraint k WHERE k.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object(
          'name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),
          'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,
          'unique',i.indisunique,'primary',i.indisprimary,
          'owner',pg_get_userbyid(ic.relowner)) ORDER BY ic.relname)
        FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object(
          'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
          'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC'
              ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),
          'using',pg_get_expr(p.polqual,p.polrelid),
          'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
        FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object(
          'name',t.tgname,'enabled',t.tgenabled,'type',t.tgtype,
          'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,
          'definition',pg_get_triggerdef(t.oid,true),
          'function',t.tgfoid::regprocedure::text,
          'function_full_definition_md5',md5(pg_get_functiondef(t.tgfoid))) ORDER BY t.tgname)
        FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    ) ORDER BY c.relname) FROM selected c),'[]'::jsonb),
    'functions',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
      'full_definition_md5',md5(pg_get_functiondef(p.oid)),
      'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,
      'security_definer',p.prosecdef,'config',p.proconfig,
      'metadata',to_jsonb(p)-'oid'-'pronamespace'-'proowner'-'prosrc')
      ORDER BY p.oid::regprocedure::text) FROM functions p),'[]'::jsonb)
  ) AS value
)
SELECT jsonb_build_object(
  'complete', (SELECT count(*)=1 FROM selected)
     AND (SELECT count(*) BETWEEN 6 AND 24 FROM functions)
     AND octet_length(value::text)<=524288,
  'relation_count',(SELECT count(*) FROM selected),
  'function_count',(SELECT count(*) FROM functions),
  'serialized_bytes',octet_length(value::text),
  'packet',CASE WHEN (SELECT count(*)=1 FROM selected)
     AND (SELECT count(*) BETWEEN 6 AND 24 FROM functions)
     AND octet_length(value::text)<=524288 THEN value ELSE NULL END
) FROM packet;
