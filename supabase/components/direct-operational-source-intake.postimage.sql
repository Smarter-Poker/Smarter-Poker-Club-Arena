-- Exact new implementation and access check; no receipt is inferred from it.
DO $postimage$
DECLARE q record; p record;
BEGIN
 FOR q IN SELECT * FROM (VALUES
('operational_source_intake.immutable_snapshot()','68bdf7a5db54e55366f6c0fa8caf189b',false,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.mapping(text,jsonb)','7cb4fc0324f276abdff8a04f2ba1307b',false,'i','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.reference(uuid)','358425f179677335a2ead4850951a958',false,'s','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.receipt_row(public.operational_alert_events,text)','844a92c85435dbef6120882773a2fd6e',false,'s','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.record_strict(text,jsonb,text,uuid)','021e82b3627b9655fc75ff37cc249188',false,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.try_delivery(uuid)','07dc4112b098fbaa4ec6e530105d166a',false,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.preserve(text,jsonb,text)','bbda8a1bddee3360d4d2c0eb65322472',false,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('operational_source_intake.record_engine(public.engine_alerts,text)','1efd93fe723c91d6bdbf35fbafa0ef6c',false,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog','TimeZone=UTC']),
('public.fn_capture_operational_source_event()','00a58b2d14702698dfd333d90458e7b7',true,'v','{postgres=X/postgres}',ARRAY['search_path=pg_catalog','TimeZone=UTC']),
('public.fn_retry_operational_source_snapshot(uuid)','129f0239ed41e51c0da6f6eb3a917d99',true,'v','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=pg_catalog']),
('public.fn_read_operational_source_snapshot(bigint)','8d7b36f717a2ec5851145838e2c6427f',true,'s','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=pg_catalog'])
 ) v(signature,body_md5,secdef,volatility,acl,config) LOOP
 SELECT md5(prosrc) body_md5,pg_get_userbyid(proowner) owner,prosecdef secdef,
   provolatile::text volatility,proacl::text acl,proconfig config INTO p
 FROM pg_proc WHERE oid=to_regprocedure(q.signature);
 IF NOT FOUND OR p.body_md5 IS DISTINCT FROM q.body_md5 OR p.owner<>'postgres'
   OR p.secdef IS DISTINCT FROM q.secdef OR p.volatility IS DISTINCT FROM q.volatility
   OR p.acl IS DISTINCT FROM q.acl OR p.config IS DISTINCT FROM q.config
 THEN RAISE EXCEPTION 'direct operational source: postimage function authority differs: %',q.signature; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_class WHERE relnamespace='operational_source_intake'::regnamespace
    AND relname IN ('snapshots','deliveries') AND relkind='r' AND relrowsecurity AND NOT relforcerowsecurity
    AND pg_get_userbyid(relowner)='postgres' AND relacl::text='{postgres=arwdDxtm/postgres,service_role=r/postgres}')<>2
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN ('operational_source_intake.snapshots'::regclass,'operational_source_intake.deliveries'::regclass))
   OR (SELECT count(*) FROM pg_trigger WHERE tgname='a00_operational_source_intake'
     AND tgrelid IN ('public.engine_alerts'::regclass,'public.financial_alerts'::regclass,'public.ca_drift_incidents'::regclass)
     AND tgenabled='O' AND tgtype=21 AND NOT tgdeferrable AND NOT tginitdeferred AND tgqual IS NULL
     AND tgfoid='public.fn_capture_operational_source_event()'::regprocedure)<>3
 THEN RAISE EXCEPTION 'direct operational source: postimage table/trigger authority differs'; END IF;
END $postimage$;
