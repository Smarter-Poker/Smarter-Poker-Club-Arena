CREATE OR REPLACE FUNCTION smarter_private.deleted_reserve_certificate_payers(p_calculation bigint)
 RETURNS TABLE(payer_kind text, payer_user uuid, payer_entity uuid, owed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE cert_tid tid;cert_xid text;v_contracts_version text;cached jsonb;cache_oid oid;
BEGIN
 -- Re-read physical row versions on every call. xmin alone is insufficient:
 -- updates performed in this same transaction retain xmin but replace ctid.
 SELECT c.ctid,c.xmin::text||'/'||c.cmin::text||'/'||c.tableoid::text||'/'||pg_catalog.pg_relation_filenode(c.tableoid)::text INTO STRICT cert_tid,cert_xid
 FROM public.accounting_rakeback_period_calculations c WHERE c.id=p_calculation;
 SELECT md5(count(*)::text||':'||coalesce(string_agg(g.tableoid::text||'/'||pg_catalog.pg_relation_filenode(g.tableoid)::text||'/'||g.ctid::text||'/'||g.xmin::text||'/'||g.cmin::text||'/'||md5(to_jsonb(g)::text),',' ORDER BY g.tableoid,g.ctid),''))
 INTO v_contracts_version FROM public.accounting_rakeback_payer_contracts g WHERE g.calculation_id=p_calculation;
 cache_oid:=to_regclass('pg_temp._deleted_reserve_payer_proofs');
 IF cache_oid IS NULL THEN
  CREATE TEMP TABLE _deleted_reserve_payer_proofs(calculation_id bigint PRIMARY KEY,certificate_tid tid NOT NULL,certificate_xid text NOT NULL,contracts_version text NOT NULL,payers jsonb NOT NULL)ON COMMIT DROP;
  REVOKE ALL ON TABLE pg_temp._deleted_reserve_payer_proofs FROM PUBLIC,anon,authenticated,service_role;
  cache_oid:=to_regclass('pg_temp._deleted_reserve_payer_proofs');
 END IF;
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_class c WHERE c.oid=cache_oid AND c.relnamespace=pg_my_temp_schema()
   AND c.relkind='r'AND c.relpersistence='t'AND pg_get_userbyid(c.relowner)='postgres'AND NOT c.relrowsecurity)
  OR EXISTS(SELECT FROM pg_catalog.pg_trigger WHERE tgrelid=cache_oid AND NOT tgisinternal)
  OR EXISTS(SELECT FROM pg_catalog.pg_rewrite WHERE ev_class=cache_oid)
  OR (SELECT count(*)FROM pg_catalog.pg_attribute WHERE attrelid=cache_oid AND attnum>0 AND NOT attisdropped)<>5
  OR EXISTS(SELECT FROM(VALUES('calculation_id','bigint'::regtype),('certificate_tid','tid'::regtype),('certificate_xid','text'::regtype),('contracts_version','text'::regtype),('payers','jsonb'::regtype))v(n,t)
   WHERE NOT EXISTS(SELECT FROM pg_catalog.pg_attribute a WHERE a.attrelid=cache_oid AND a.attname=v.n AND a.atttypid=v.t AND a.attnotnull AND a.attnum>0 AND NOT a.attisdropped))
  OR EXISTS(SELECT FROM(VALUES('anon'),('authenticated'),('service_role'))roles(n)
   WHERE has_table_privilege(roles.n,cache_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')OR has_any_column_privilege(roles.n,cache_oid,'SELECT,INSERT,UPDATE,REFERENCES'))
 THEN RAISE EXCEPTION 'deleted_reserve_payer_proof_temp_not_authoritative' USING ERRCODE='42501';END IF;
 SELECT p.payers INTO cached FROM pg_temp._deleted_reserve_payer_proofs p
 WHERE p.calculation_id=p_calculation AND p.certificate_tid=cert_tid AND p.certificate_xid=cert_xid AND p.contracts_version=v_contracts_version;
 IF NOT FOUND THEN
  -- The unchanged original validator is the sole producer of reusable output.
  SELECT coalesce(jsonb_agg(to_jsonb(p)ORDER BY p.payer_kind,p.payer_entity),'[]'::jsonb)INTO cached
  FROM smarter_private.rakeback_certificate_payers(p_calculation)p;
  INSERT INTO pg_temp._deleted_reserve_payer_proofs VALUES(p_calculation,cert_tid,cert_xid,v_contracts_version,cached)
  ON CONFLICT(calculation_id)DO UPDATE SET certificate_tid=EXCLUDED.certificate_tid,certificate_xid=EXCLUDED.certificate_xid,contracts_version=EXCLUDED.contracts_version,payers=EXCLUDED.payers;
 END IF;
 RETURN QUERY SELECT r.payer_kind,r.payer_user,r.payer_entity,r.owed FROM jsonb_to_recordset(cached)AS r(payer_kind text,payer_user uuid,payer_entity uuid,owed numeric);
END $function$
;
