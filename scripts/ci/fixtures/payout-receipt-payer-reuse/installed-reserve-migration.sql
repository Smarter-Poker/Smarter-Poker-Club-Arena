-- @live-proof: md5(pg_get_functiondef('smarter_private.deleted_reserve_certificate_payers(bigint)'::regprocedure))='c2a3aedb97cf5782be7e9bc7a2a6e03b' AND md5(pg_get_functiondef('smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)'::regprocedure))='2673336b266659907cb9a787d9847a18' AND md5(pg_get_functiondef('smarter_private.rakeback_certificate_payers(bigint)'::regprocedure))='89b7297462b6cd4ba6bf145c7d5fa261'
BEGIN;
SET LOCAL lock_timeout='2s';
DO $pre$ BEGIN
 IF md5(pg_get_functiondef('smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)'::regprocedure))<>'0257fa521e81c9d889449b428fd1e72c'OR md5(pg_get_functiondef('smarter_private.rakeback_certificate_payers(bigint)'::regprocedure))<>'89b7297462b6cd4ba6bf145c7d5fa261'THEN RAISE EXCEPTION 'deleted_reserve_reuse_preimage_changed';END IF;
END $pre$;
CREATE FUNCTION smarter_private.deleted_reserve_certificate_payers(p_calculation bigint)
RETURNS TABLE(payer_kind text,payer_user uuid,payer_entity uuid,owed numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION smarter_private.deleted_reserve_certificate_payers(bigint)FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.deleted_wallet_published_rakeback_reserve(p_club uuid, p_user uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
 r public.rakeback_periods%ROWTYPE;
 c public.accounting_rakeback_period_calculations%ROWTYPE;
 reserved numeric:=0;
 locked_period_ids uuid[];
BEGIN
 IF p_club IS NULL OR p_user IS NULL THEN
  RAISE EXCEPTION 'deleted_wallet_reserve_identity_required' USING ERRCODE='22023';
 END IF;
 -- Publishers lock an existing period FOR UPDATE before adding its certificate.
 -- NOWAIT is essential: caller may already own the member row, while the
 -- ordinary stage owns period rows before member rows. Never wait in reverse.
 SELECT coalesce(array_agg(locked.id ORDER BY locked.id),ARRAY[]::uuid[]) INTO locked_period_ids
 FROM (SELECT rp.id FROM public.rakeback_periods rp
       WHERE rp.club_id=p_club AND rp.status='pending'
       ORDER BY rp.id FOR SHARE NOWAIT) locked;
 -- Visit ONLY the locked admission cohort, not a second fresh pending scan.
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp
          WHERE rp.id=ANY(locked_period_ids) ORDER BY rp.id
 LOOP
  -- Select latest FIRST. An invalid latest certificate must not expose funds
  -- by falling back to an older certificate or disappearing from a filtered sum.
  SELECT pc.* INTO c FROM public.accounting_rakeback_period_calculations pc
  WHERE pc.period_id=r.id ORDER BY pc.id DESC LIMIT 1;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_latest_certificate_required' USING ERRCODE='55000';
  END IF;
  IF r.id IS NULL OR r.club_id IS NULL OR r.club_id IS DISTINCT FROM p_club
   OR r.user_id IS NULL OR r.period_start IS NULL OR r.period_end IS NULL
   OR NOT isfinite(r.period_start) OR NOT isfinite(r.period_end)
   OR r.period_start>r.period_end OR extract(isodow FROM r.period_start)<>1 OR r.period_end<>r.period_start+6
   OR r.rake_generated IS NULL OR r.total_rake_paid IS NULL
   OR r.rakeback_amount IS NULL OR r.rakeback_earned IS NULL OR r.rakeback_rate IS NULL
   OR c.id IS NULL OR c.period_id IS DISTINCT FROM r.id
   OR c.accounting_version IS DISTINCT FROM 2
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS NULL OR c.rake_generated IS DISTINCT FROM r.rake_generated
   OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rake_generated<0 OR c.rake_generated::text IN ('NaN','Infinity','-Infinity')
   OR c.rakeback_amount IS NULL OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.rakeback_amount<0 OR c.rakeback_amount>c.rake_generated OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN ('NaN','Infinity','-Infinity')
   OR c.display_rate IS NULL OR c.display_rate IS DISTINCT FROM r.rakeback_rate
   OR c.display_rate<0 OR c.display_rate>1 OR c.display_rate<>round(c.display_rate,4)
   OR c.display_rate::text IN ('NaN','Infinity','-Infinity')
   OR c.payer_kind IS NULL OR c.payer_kind NOT IN ('agent','club','split')
   OR (c.payer_kind='agent') IS DISTINCT FROM (c.payer_user_id IS NOT NULL)
   OR c.payer_user_id=r.user_id
   OR c.source_fingerprint IS NULL OR c.source_fingerprint !~ '^[0-9a-f]{32}$'
  THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_certificate_identity_invalid' USING ERRCODE='55000';
  END IF;
  -- The owning R3 stage refuses any existing payout for a pending period.
  -- A pending row plus a paid receipt must never be mistaken for free money.
  IF EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=r.id) THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_pending_payout_conflict' USING ERRCODE='55000';
  END IF;
  IF c.payer_kind='split' THEN
   -- Same immutable certificate producer; retain all child liabilities before
   -- any deleted account's free net is returned by the existing R2/R3 owner.
   reserved:=reserved+COALESCE((SELECT sum(g.owed) FROM smarter_private.deleted_reserve_certificate_payers(c.id)g WHERE g.payer_kind='agent' AND g.payer_user=p_user),0);
  ELSIF c.payer_kind='agent' AND c.payer_user_id=p_user THEN
   reserved:=reserved+c.rakeback_amount;
  END IF;
 END LOOP;
 RETURN reserved;
END;
$function$;
REVOKE ALL ON FUNCTION smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)FROM PUBLIC,anon,authenticated,service_role;
DO $post$ BEGIN IF NOT(md5(pg_get_functiondef('smarter_private.deleted_reserve_certificate_payers(bigint)'::regprocedure))='c2a3aedb97cf5782be7e9bc7a2a6e03b' AND md5(pg_get_functiondef('smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)'::regprocedure))='2673336b266659907cb9a787d9847a18' AND md5(pg_get_functiondef('smarter_private.rakeback_certificate_payers(bigint)'::regprocedure))='89b7297462b6cd4ba6bf145c7d5fa261')THEN RAISE EXCEPTION 'deleted_reserve_reuse_postimage_changed';END IF;END $post$;
COMMIT;
