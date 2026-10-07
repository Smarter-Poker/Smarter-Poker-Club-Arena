-- Catalog metadata only. No application relation is read or mutated.
SET search_path = pg_catalog;
SELECT jsonb_build_object(
  'database', (SELECT jsonb_build_array(d.datname,pg_get_userbyid(d.datdba),
    d.datacl::text,pg_encoding_to_char(d.encoding),d.datcollate,d.datctype,
    d.datlocprovider,d.datlocale,d.datcollversion,d.datconnlimit,
    t.spcname) FROM pg_database d JOIN pg_tablespace t ON t.oid=d.dattablespace
    WHERE d.datname=current_database()),
  'database_settings', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(CASE WHEN s.setrole=0 THEN NULL ELSE pg_get_userbyid(s.setrole) END,
      s.setconfig) x FROM pg_db_role_setting s
    WHERE s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())) q),
  'sql_settings', (SELECT jsonb_agg(jsonb_build_array(name,setting) ORDER BY name)
    FROM pg_settings WHERE name IN ('row_security','session_replication_role',
      'check_function_bodies','standard_conforming_strings','default_transaction_isolation',
      'transform_null_equals')),
  'tablespaces', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(spcname,pg_get_userbyid(spcowner),spcacl::text,spcoptions) x
    FROM pg_tablespace) q),
  'extensions', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(e.extname,e.extversion,n.nspname,pg_get_userbyid(e.extowner)) x
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace) q),
  'roles', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,
      rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig) x
    FROM pg_roles WHERE rolname <> 'leaderboard_qualification_bootstrap') q),
  'memberships', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(r.rolname,m.rolname,g.rolname,a.admin_option,
      a.inherit_option,a.set_option) x FROM pg_auth_members a
    JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member
    JOIN pg_roles g ON g.oid=a.grantor) q),
  'schemas', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(n.nspname,pg_get_userbyid(n.nspowner),n.nspacl::text) x
    FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') q),
  'relations', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner),
      c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,c.reloptions,
      t.spcname,CASE WHEN c.relkind IN ('v','m') THEN md5(pg_get_viewdef(c.oid,false)) ELSE NULL END) x
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_tablespace t ON t.oid=c.reltablespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') q),
  'columns', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    -- Ordinary pg_dump omits dropped slots. Compare the exact live-column
    -- order, not internal physical slot numbers that native restore renumbers.
    SELECT jsonb_build_array(n.nspname,c.relname,a.attname,
      row_number() OVER (PARTITION BY a.attrelid ORDER BY a.attnum),
      format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
      pg_get_expr(d.adbin,d.adrelid),a.attacl::text) x
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attnum>0 AND NOT a.attisdropped AND n.nspname !~ '^pg_'
      AND n.nspname <> 'information_schema') q),
  'routines', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),
      p.prokind,pg_get_userbyid(p.proowner),p.prosecdef,p.proconfig,p.proacl::text,
      CASE WHEN p.prokind <> 'a' THEN md5(pg_get_functiondef(p.oid)) ELSE md5(p.prosrc) END) x
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') q),
  'constraints', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(n.nspname,c.relname,k.conname,k.contype,
      pg_get_constraintdef(k.oid),k.convalidated) x
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') q),
  'domain_constraints', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(n.nspname,t.typname,k.conname,k.contype,
      pg_get_constraintdef(k.oid),k.convalidated) x FROM pg_constraint k
    JOIN pg_type t ON t.oid=k.contypid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE k.conrelid=0 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') q),
  'indexes', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(n.nspname,c.relname,pg_get_indexdef(i.indexrelid),
      i.indisvalid,i.indisready) x FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') q),
  'triggers', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) x
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal
    AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') q),
  'event_triggers', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(e.evtname,e.evtevent,pg_get_userbyid(e.evtowner),
      e.evtenabled,e.evttags,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) x
    FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid
    JOIN pg_namespace n ON n.oid=p.pronamespace) q),
  'publications', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(pubname,pg_get_userbyid(pubowner),puballtables,pubinsert,
      pubupdate,pubdelete,pubtruncate,pubviaroot) x FROM pg_publication) q),
  'publication_relations', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    -- Explicit publication columns follow restored column identity/order,
    -- never source-internal physical attribute numbers.
    SELECT jsonb_build_array(p.pubname,n.nspname,c.relname,
      CASE WHEN r.prattrs IS NULL THEN NULL ELSE (
        SELECT jsonb_agg(a.attname ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid=r.prrelid
          AND a.attnum=ANY(r.prattrs::smallint[]) AND NOT a.attisdropped
      ) END,
      pg_get_expr(r.prqual,r.prrelid)) x FROM pg_publication_rel r
    JOIN pg_publication p ON p.oid=r.prpubid JOIN pg_class c ON c.oid=r.prrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace) q),
  'publication_schemas', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(p.pubname,n.nspname) x FROM pg_publication_namespace r
    JOIN pg_publication p ON p.oid=r.pnpubid JOIN pg_namespace n ON n.oid=r.pnnspid) q),
  'policies', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check) x
    FROM pg_policies WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema') q),
  'types', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(n.nspname,t.typname,t.typtype,pg_get_userbyid(t.typowner),
      format_type(t.typbasetype,t.typtypmod),t.typnotnull,t.typdefault,t.typacl::text,
      (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid)) x
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') q),
  'defaults', (SELECT jsonb_agg(x ORDER BY x::text) FROM (
    SELECT jsonb_build_array(pg_get_userbyid(d.defaclrole),n.nspname,d.defaclobjtype,d.defaclacl::text) x
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace) q)
);
