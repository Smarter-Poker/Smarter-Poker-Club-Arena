-- Install the already reviewed private diagnostic reader consumed by the
-- explicit Horse daily review command. The three audit tables already exist;
-- this migration neither recreates them nor runs the audit or changes policy.
-- Reader source SHA256: 61fb9576f9e0fd1e814d9085a4f1d10b01df16cf366cb00ef6affdf2c9f49aff.
-- Reserved with scripts/reserve-migration-version.sh; current production
-- readback on 2026-09-17 verified the target is absent and auth.role is pinned.
BEGIN;
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '5s';
DO $preimage$
DECLARE relation_name text; role_name text; relation_oid oid;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'horse_daily_reader_owner_required';
  END IF;
  IF to_regprocedure('public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'horse_daily_reader_already_exists';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('auth.role()'))
      IS DISTINCT FROM 'f31486fed08a7402e89d4aa71b0ad273' THEN
    RAISE EXCEPTION 'horse_daily_reader_auth_preimage_changed';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY['horse_commitment_audit_days','horse_commitment_reviews','horse_commitment_audit_gaps'] LOOP
    relation_oid := to_regclass('public.' || relation_name);
    IF relation_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_class WHERE oid=relation_oid AND relrowsecurity
        AND relkind='r' AND pg_get_userbyid(relowner)='postgres'
    ) THEN
      RAISE EXCEPTION 'horse_daily_reader_private_schema_required';
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(role_name,relation_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(role_name,relation_oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'horse_daily_reader_private_acl_changed';
      END IF;
    END LOOP;
  END LOOP;
END;
$preimage$;

-- PREPARED/UNEXECUTED. Private diagnostic reader; no queue/source/financial writes.
-- Requires the exact reviewed horse_committed_pot_daily_audit schema.
CREATE FUNCTION public.fn_horse_commitment_review_page(
 p_day date,p_after_played_at timestamptz DEFAULT NULL,p_after_hand_id uuid DEFAULT NULL,
 p_after_horse_user_id uuid DEFAULT NULL,p_limit integer DEFAULT 8)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET statement_timeout='3s' SET timezone='UTC'
AS $fn$
DECLARE r record; item jsonb; items jsonb:='[]'; last_cursor jsonb:=NULL;
 count_rows integer:=0; more boolean:=false; safe boolean; captured_at timestamptz:=statement_timestamp();
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'private_daily_reader_role_required' USING ERRCODE='42501'; END IF;
 IF p_day IS NULL OR p_day<DATE '2000-01-01' OR p_day>=DATE '2100-01-01'
  OR p_day>=(captured_at AT TIME ZONE 'UTC')::date OR p_limit IS DISTINCT FROM 8
  OR num_nonnulls(p_after_played_at,p_after_hand_id,p_after_horse_user_id) NOT IN (0,3)
  OR (p_after_played_at IS NOT NULL AND (NOT isfinite(p_after_played_at) OR (p_after_played_at AT TIME ZONE 'UTC')::date<>p_day))
 THEN RAISE EXCEPTION 'invalid_private_daily_page_request' USING ERRCODE='22023'; END IF;
 FOR r IN
  SELECT q.hand_id,q.horse_user_id,q.table_id,q.played_at,
   CASE WHEN octet_length(q.source_payload_hash)<=64 THEN q.source_payload_hash END AS hash,
   CASE WHEN octet_length(q.game_variant)<=64 THEN q.game_variant END AS variant,
   CASE WHEN octet_length(q.format)<=64 THEN q.format END AS format,
   q.eligibility,q.big_blind IS NULL AS bb_null,q.committed_bb IS NULL AS committed_null,
   CASE WHEN pg_column_size(q.big_blind)<=128 THEN CASE WHEN length(q.big_blind::text)<=64 THEN q.big_blind::text END END AS bb,
   CASE WHEN pg_column_size(q.committed_bb)<=128 THEN CASE WHEN length(q.committed_bb::text)<=64 THEN q.committed_bb::text END END AS committed,
   CASE WHEN pg_column_size(q.reasons)<=8192 AND cardinality(q.reasons)<=32 AND (cardinality(q.reasons)=0 OR array_ndims(q.reasons)=1) THEN q.reasons END AS reasons,
   CASE WHEN g.hand_id IS NULL THEN ARRAY[]::text[] WHEN pg_column_size(g.reasons)<=8192 AND cardinality(g.reasons)<=32 AND (cardinality(g.reasons)=0 OR array_ndims(g.reasons)=1) THEN g.reasons END AS gaps
  FROM public.horse_commitment_reviews q
  LEFT JOIN public.horse_commitment_audit_gaps g ON g.hand_id=q.hand_id
  WHERE q.played_at>=p_day::timestamp AT TIME ZONE 'UTC' AND q.played_at<(p_day+1)::timestamp AT TIME ZONE 'UTC'
   AND (p_after_played_at IS NULL OR (q.played_at,q.hand_id,q.horse_user_id)>(p_after_played_at,p_after_hand_id,p_after_horse_user_id))
  ORDER BY q.played_at,q.hand_id,q.horse_user_id LIMIT 9
 LOOP
  count_rows:=count_rows+1; IF count_rows=9 THEN more:=true; EXIT; END IF;
  last_cursor:=jsonb_build_object('playedAt',to_char(r.played_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'handId',r.hand_id,'horseId',r.horse_user_id);
  safe:=r.hash~'^[0-9a-f]{64}$' AND r.variant IS NOT NULL AND r.format IS NOT NULL
   AND r.reasons IS NOT NULL AND r.gaps IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM unnest(r.reasons||r.gaps) x WHERE x IS NULL OR octet_length(x)>160)
   AND (r.bb IS NOT NULL OR r.bb_null) AND (r.committed IS NOT NULL OR r.committed_null)
   AND (r.bb IS NULL OR r.bb~'^(0|[1-9][0-9]*)(\.[0-9]+)?$')
   AND (r.committed IS NULL OR r.committed~'^(0|[1-9][0-9]*)(\.[0-9]+)?$');
  item:=last_cursor||jsonb_build_object('tableId',r.table_id,'status','payload_unavailable','payloadHash',NULL,
   'variant',NULL,'format',NULL,'eligibility','unknown','bigBlind',NULL,'committedBb',NULL,
   'reasons',jsonb_build_array('daily_payload_unavailable'),'gaps',jsonb_build_array());
  IF safe IS TRUE THEN
   item:=last_cursor||jsonb_build_object('tableId',r.table_id,'status','retained_diagnostic','payloadHash',r.hash,
    'variant',r.variant,'format',r.format,'eligibility',r.eligibility,'bigBlind',r.bb,'committedBb',r.committed,
    'reasons',r.reasons,'gaps',r.gaps);
   -- JSON escaping can expand otherwise bounded strings; bound before aggregation/wire.
   IF octet_length(item::text)>6000 THEN
    item:=last_cursor||jsonb_build_object('tableId',r.table_id,'status','payload_unavailable','payloadHash',NULL,
     'variant',NULL,'format',NULL,'eligibility','unknown','bigBlind',NULL,'committedBb',NULL,
     'reasons',jsonb_build_array('daily_payload_unavailable'),'gaps',jsonb_build_array());
   END IF;
  END IF;
  items:=items||jsonb_build_array(item);
 END LOOP;
 RETURN jsonb_build_object('version',1,'source','horse_commitment_reviews','day',p_day,'limit',8,
  'after',CASE WHEN p_after_played_at IS NULL THEN NULL ELSE jsonb_build_object('playedAt',to_char(p_after_played_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'handId',p_after_hand_id,'horseId',p_after_horse_user_id) END,
  'readAt',to_char(captured_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'rows',items,'hasMore',more,'next',last_cursor,
  'dayObservation',CASE WHEN EXISTS(SELECT 1 FROM public.horse_commitment_audit_days WHERE day=p_day) THEN 'present' ELSE 'missing' END,
  'sourceCoverage','not_established','identityBasis','current_profile_is_horse','gtoVerified',false,'activationAllowed',false);
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer) TO service_role;
-- No table grants, source locks, cursor updates, retention changes or policy effects.

-- Invalidate only the gateway schema cache after this transaction commits.
NOTIFY pgrst, 'reload schema';
COMMIT;
