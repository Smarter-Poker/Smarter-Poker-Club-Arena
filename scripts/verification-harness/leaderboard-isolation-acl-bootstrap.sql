-- SELECT-only source export. Output is private SQL for owned disposable restore.
-- Never execute the generated transaction on source; exact catalog equality
-- remains authoritative. NULL ACLs and unowned grant chains are not normalized.
WITH objects AS (
  SELECT 'DATABASE' kind, NULL::text namespace, datname name,
    datdba owner_oid, datacl acl,'[]'::jsonb columns FROM pg_catalog.pg_database
    WHERE datname=current_database() AND datacl IS NOT NULL
  UNION ALL
  SELECT 'SCHEMA',NULL,nspname,nspowner,nspacl,'[]'::jsonb FROM pg_catalog.pg_namespace
    WHERE nspname !~ '^pg_' AND nspname<>'information_schema' AND nspacl IS NOT NULL
  UNION ALL
  SELECT CASE WHEN relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,n.nspname,c.relname,c.relowner,c.relacl,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,
      'acl',CASE WHEN a.attacl IS NULL THEN NULL ELSE COALESCE((SELECT jsonb_agg(v::text ORDER BY v::text) FROM unnest(a.attacl) v),'[]'::jsonb) END,
      'owner_only',NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(a.attacl) x WHERE x.grantor<>c.relowner)) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relacl IS NOT NULL
      AND c.relkind IN ('r','p','v','m','f','S')
), inventory AS (
  SELECT jsonb_agg(jsonb_build_object('kind',kind,'namespace',namespace,'name',name,
    'owner',pg_catalog.pg_get_userbyid(owner_oid),
    'acl',COALESCE((SELECT jsonb_agg(v::text ORDER BY v::text) FROM unnest(acl) v),'[]'::jsonb),
    'columns',columns,'owner_only',NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(acl) a WHERE a.grantor<>owner_oid))
    ORDER BY kind,namespace,name) rows FROM objects
)
SELECT pg_catalog.format('BEGIN; DO %L; COMMIT;',pg_catalog.format($template$
DECLARE expected jsonb:=%1$L::jsonb; item jsonb; owner_id oid; object_id oid;
  actual_owner oid; actual_acl aclitem[]; target aclitem[]; entry record; grantee text;
  sql_object text; role_name text; db_owner text:=%2$L; grants text[]; target_text text[];
  column_item jsonb; column_acl aclitem[]; column_observed jsonb;
  actual_acl_was_null boolean;
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
    OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres' THEN
    RAISE EXCEPTION 'ACL bootstrap requires exact disposable socket identity';
  END IF;
  IF expected IS NULL OR jsonb_typeof(expected)<>'array' THEN
    RAISE EXCEPTION 'Source ACL inventory unavailable';
  END IF;
  IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())<>db_owner THEN
    RAISE EXCEPTION 'Dynamic database owner differs';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(expected) LOOP
    IF item->'owner_only' IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'Unsupported source ACL grant chain';
    END IF;
    owner_id:=NULL; object_id:=NULL; actual_owner:=NULL; actual_acl:=NULL;
    SELECT oid INTO STRICT owner_id FROM pg_roles WHERE rolname=item->>'owner';
    target:=ARRAY(SELECT value::aclitem FROM jsonb_array_elements_text(item->'acl'));
    IF item->>'kind'='DATABASE' THEN
      SELECT oid,datdba,datacl INTO STRICT object_id,actual_owner,actual_acl FROM pg_database
        WHERE datname=item->>'name' AND datname=current_database();
      actual_acl_was_null:=actual_acl IS NULL;
      actual_acl:=COALESCE(actual_acl,acldefault('d',actual_owner));
      sql_object:=format('DATABASE %%I',item->>'name');
    ELSIF item->>'kind'='SCHEMA' THEN
      SELECT oid,nspowner,nspacl INTO STRICT object_id,actual_owner,actual_acl FROM pg_namespace
        WHERE nspname=item->>'name';
      actual_acl_was_null:=actual_acl IS NULL;
      actual_acl:=COALESCE(actual_acl,acldefault('n',actual_owner));
      sql_object:=format('SCHEMA %%I',item->>'name');
    ELSIF item->>'kind' IN ('TABLE','SEQUENCE') THEN
      SELECT c.oid,c.relowner,c.relacl INTO STRICT object_id,actual_owner,actual_acl
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=item->>'namespace' AND c.relname=item->>'name'
          AND ((item->>'kind'='SEQUENCE' AND c.relkind='S')
            OR (item->>'kind'='TABLE' AND c.relkind IN ('r','p','v','m','f')));
      actual_acl_was_null:=actual_acl IS NULL;
      actual_acl:=COALESCE(actual_acl,acldefault(CASE WHEN item->>'kind'='SEQUENCE' THEN 's'::"char" ELSE 'r'::"char" END,actual_owner));
      sql_object:=format('%%s %%I.%%I',item->>'kind',item->>'namespace',item->>'name');
    ELSE RAISE EXCEPTION 'Unsupported source ACL object'; END IF;
    IF actual_owner<>owner_id OR EXISTS(SELECT 1 FROM aclexplode(CASE WHEN cardinality(actual_acl)=0 THEN NULL::aclitem[] ELSE actual_acl END) a WHERE a.grantor<>owner_id)
      OR EXISTS(SELECT 1 FROM aclexplode(CASE WHEN cardinality(target)=0 THEN NULL::aclitem[] ELSE target END) a WHERE a.grantor<>owner_id) THEN
      RAISE EXCEPTION 'ACL owner or grant chain differs';
    END IF;
    SELECT array_agg(v::text ORDER BY v::text) INTO grants FROM unnest(actual_acl) v;
    SELECT array_agg(v::text ORDER BY v::text) INTO target_text FROM unnest(target) v;
    -- Source targets are explicit NONNULL ACLs. A pristine destination NULL
    -- may have equivalent effective defaults but is NOT the exact postimage.
    IF NOT actual_acl_was_null AND grants IS NOT DISTINCT FROM target_text THEN CONTINUE; END IF;
    FOR column_item IN SELECT value FROM jsonb_array_elements(item->'columns') LOOP
      IF column_item->'owner_only' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Unsupported source column ACL grant chain'; END IF;
      SELECT CASE WHEN a.attacl IS NULL THEN NULL ELSE COALESCE((SELECT jsonb_agg(v::text ORDER BY v::text) FROM unnest(a.attacl) v),'[]'::jsonb) END
        INTO STRICT column_observed FROM pg_attribute a WHERE a.attrelid=object_id AND a.attname=column_item->>'name' AND a.attnum>0 AND NOT a.attisdropped;
      IF column_observed IS DISTINCT FROM NULLIF(column_item->'acl','null'::jsonb) THEN RAISE EXCEPTION 'Column ACL preimage differs'; END IF;
    END LOOP;
    role_name:=item->>'owner';
    IF role_name='pg_database_owner' THEN
      IF item->>'kind'<>'SCHEMA' OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE oid=(SELECT oid FROM pg_database WHERE datname=current_database()))<>db_owner THEN
        RAISE EXCEPTION 'Dynamic database owner differs';
      END IF;
      role_name:=db_owner;
    END IF;
    EXECUTE format('SET LOCAL ROLE %%I',role_name);
    FOR entry IN SELECT DISTINCT a.grantee FROM aclexplode(CASE WHEN cardinality(actual_acl||target)=0 THEN NULL::aclitem[] ELSE actual_acl||target END) a LOOP
      grantee:=CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE format('%%I',pg_get_userbyid(entry.grantee)) END;
      EXECUTE format('REVOKE ALL PRIVILEGES ON %%s FROM %%s',sql_object,grantee);
    END LOOP;
    FOR entry IN SELECT * FROM aclexplode(CASE WHEN cardinality(target)=0 THEN NULL::aclitem[] ELSE target END) LOOP
      IF entry.privilege_type NOT IN ('CREATE','CONNECT','TEMPORARY','USAGE','SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN') THEN
        RAISE EXCEPTION 'Unsupported ACL privilege';
      END IF;
      grantee:=CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE format('%%I',pg_get_userbyid(entry.grantee)) END;
      EXECUTE format('GRANT %%s ON %%s TO %%s%%s',entry.privilege_type,sql_object,grantee,
        CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    -- Table-level REVOKE also removes column grants. Recreate exact source
    -- column privileges under the same owner, never a different grant chain.
    FOR column_item IN SELECT value FROM jsonb_array_elements(item->'columns') LOOP
      IF column_item->'acl'='null'::jsonb THEN CONTINUE; END IF;
      column_acl:=ARRAY(SELECT value::aclitem FROM jsonb_array_elements_text(column_item->'acl'));
      FOR entry IN SELECT * FROM aclexplode(CASE WHEN cardinality(column_acl)=0 THEN NULL::aclitem[] ELSE column_acl END) LOOP
        IF entry.grantor<>owner_id OR entry.privilege_type NOT IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN RAISE EXCEPTION 'Unsupported source column ACL'; END IF;
        grantee:=CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE format('%%I',pg_get_userbyid(entry.grantee)) END;
        EXECUTE format('GRANT %%s (%%I) ON %%s TO %%s%%s',entry.privilege_type,column_item->>'name',sql_object,grantee,
          CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
    END LOOP;
    RESET ROLE;
    IF item->>'kind'='DATABASE' THEN SELECT datacl INTO actual_acl FROM pg_database WHERE oid=object_id;
    ELSIF item->>'kind'='SCHEMA' THEN SELECT nspacl INTO actual_acl FROM pg_namespace WHERE oid=object_id;
    ELSE SELECT relacl INTO actual_acl FROM pg_class WHERE oid=object_id; END IF;
    SELECT array_agg(v::text ORDER BY v::text) INTO grants FROM unnest(actual_acl) v;
    IF grants IS DISTINCT FROM target_text THEN RAISE EXCEPTION 'ACL exact content readback differs'; END IF;
    FOR column_item IN SELECT value FROM jsonb_array_elements(item->'columns') LOOP
      SELECT CASE WHEN a.attacl IS NULL THEN NULL ELSE COALESCE((SELECT jsonb_agg(v::text ORDER BY v::text) FROM unnest(a.attacl) v),'[]'::jsonb) END
        INTO STRICT column_observed FROM pg_attribute a WHERE a.attrelid=object_id AND a.attname=column_item->>'name' AND a.attnum>0 AND NOT a.attisdropped;
      IF column_observed IS DISTINCT FROM NULLIF(column_item->'acl','null'::jsonb) THEN RAISE EXCEPTION 'Column ACL readback differs'; END IF;
    END LOOP;
  END LOOP;
END;
$template$,rows,(SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname=current_database()))) FROM inventory;
