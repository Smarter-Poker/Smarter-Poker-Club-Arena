SELECT clock_timestamp() AS observed_at,current_setting('server_version') AS server_version,
 n.nspname AS schema,c.relname AS name,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl,
 c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,c.reloptions,
 (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(ad.adbin,ad.adrelid),'acl',a.attacl::text) ORDER BY a.attnum)
 FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
 (SELECT jsonb_agg(jsonb_build_object('name',co.conname,'type',co.contype,'definition',pg_get_constraintdef(co.oid),'validated',co.convalidated,'deferrable',co.condeferrable,'deferred',co.condeferred) ORDER BY co.conname) FROM pg_constraint co WHERE co.conrelid=c.oid) AS constraints,
 (SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid) AS indexes,
 (SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::text) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers,
 (SELECT jsonb_agg(to_jsonb(po) ORDER BY po.policyname) FROM pg_policies po WHERE po.schemaname=n.nspname AND po.tablename=c.relname) AS policies,
 current_setting('search_path') AS capture_search_path
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname='ca_chip_store_coverage';
