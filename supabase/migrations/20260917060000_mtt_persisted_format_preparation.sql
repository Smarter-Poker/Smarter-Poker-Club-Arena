-- Preparation only. No entry-cap removal, NULL-capacity writes or activation.
-- Immutable event format is read through the launch receipt's existing parent FK;
-- duplicating it in tournament_launch_receipts would create another authority.
BEGIN;
SET LOCAL lock_timeout = '3s';
-- Schema preparation holds the tournaments schema lock only for DDL. Existing
-- rows are qualified afterward in finite explicit transactions, with the same
-- timeouts, origin triggers and exact provenance checks. No runtime repair loop.
SET LOCAL statement_timeout = '5s';

DO $preimages$
DECLARE item record;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.tournaments'::regclass
      AND attname='format_contract' AND NOT attisdropped)
     OR to_regclass('public.ca_mtt_admission_contract') IS NOT NULL THEN
    RAISE EXCEPTION 'MTT format preparation already present; require exact installation readback';
  END IF;
  -- The active-ID index predicate below is redundant only under this exact
  -- validated uppercase domain. Refuse drift instead of silently omitting
  -- a differently cased historical status from the original upper() filter.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint
      WHERE conrelid='public.tournaments'::regclass
        AND conname='tournaments_status_check' AND contype='c'
        AND convalidated
        AND pg_get_constraintdef(oid)=$status_check$CHECK ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text, 'LATE_REG'::text, 'RUNNING'::text, 'COMPLETING'::text, 'COMPLETED'::text, 'CANCELLED'::text])))$status_check$) THEN
    RAISE EXCEPTION 'MTT format requires the exact validated status domain';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('public.fn_managed_game_contract_document(text,jsonb)','e691ed61c33d5b6b91045a6575245b70'),
    ('public.fn_managed_game_contract_hash(jsonb)','8a737732798402cb46c6863159a940d1'),
    ('public.fn_guard_managed_game_contract_version()','2df506246cd94bdc2238e20f8f4894c1'),
    ('public.fn_capture_managed_game_contract()','47d5969e7c3332e02f0b4383c51b7d79')
  ) expected(signature,source_md5) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=to_regprocedure(item.signature))
        IS DISTINCT FROM item.source_md5 THEN
      RAISE EXCEPTION 'MTT format provenance authority drift: %',item.signature;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint
      WHERE conrelid='public.tournament_launch_receipts'::regclass
        AND conname='tournament_launch_receipts_tournament_id_fkey'
        AND contype='f' AND confrelid='public.tournaments'::regclass
        AND convalidated AND confdeltype='r') THEN
    RAISE EXCEPTION 'MTT format requires the existing restrictive launch-parent FK';
  END IF;
END $preimages$;

-- A registered parent checks every protected key in the lifecycle guard.
-- Serialize its unchanged OLD/NEW rows once, at the same guarded branch.
-- Keep owner, ACL, search path, security mode, protected keys and all refusals.
DO $lifecycle_guard$
DECLARE v_definition text; v_source text; v_acl jsonb; v_owner text;
BEGIN
 SELECT pg_get_functiondef(p.oid),md5(p.prosrc),pg_get_userbyid(p.proowner),
   (SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege',a.privilege_type,'grantable',a.is_grantable)
      ORDER BY a.grantee::regrole::text,a.privilege_type,a.is_grantable)
    FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)
 INTO v_definition,v_source,v_owner,v_acl FROM pg_proc p
 WHERE p.oid=to_regprocedure('public.fn_guard_managed_game_lifecycle()');
 IF v_source IS DISTINCT FROM '7f2ba185a5714534dff4e4c01d07466e'
    OR md5(v_definition) IS DISTINCT FROM '16d4a93cbee7574608e18287bf555f24'
    OR v_owner IS DISTINCT FROM 'postgres'
    OR v_acl IS DISTINCT FROM '[{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"EXECUTE"},{"grantee":"service_role","grantor":"postgres","grantable":false,"privilege":"EXECUTE"}]'::jsonb THEN
   RAISE EXCEPTION 'MTT format lifecycle guard preimage drift';
 END IF;
 v_definition:=replace(v_definition,$old$  v_key text;$old$,
   $new$  v_key text;
  v_new_document jsonb;
  v_old_document jsonb;$new$);
 v_definition:=replace(v_definition,$old$    IF NOT v_is_engine THEN
      FOREACH$old$,$new$    IF NOT v_is_engine THEN
      v_new_document := to_jsonb(NEW);
      v_old_document := to_jsonb(OLD);
      FOREACH$new$);
 v_definition:=replace(v_definition,
   '(to_jsonb(NEW) -> v_key) IS DISTINCT FROM (to_jsonb(OLD) -> v_key)',
   '(v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key)');
 IF md5(v_definition)<>'e4e6dbe534f8ed1fc7fa03fcad968114' THEN
   RAISE EXCEPTION 'MTT format lifecycle guard replacement drift';
 END IF;
 EXECUTE v_definition;
 IF (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid='public.fn_guard_managed_game_lifecycle()'::regprocedure)<>'2f9ec1b3624945c0c6ff3421dbc17980'
    OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
       WHERE p.oid='public.fn_guard_managed_game_lifecycle()'::regprocedure)<>'e4e6dbe534f8ed1fc7fa03fcad968114'
    OR (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
       WHERE p.oid='public.fn_guard_managed_game_lifecycle()'::regprocedure) IS DISTINCT FROM v_owner
    OR (SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
         'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
         'privilege',a.privilege_type,'grantable',a.is_grantable)
         ORDER BY a.grantee::regrole::text,a.privilege_type,a.is_grantable)
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
        WHERE p.oid='public.fn_guard_managed_game_lifecycle()'::regprocedure) IS DISTINCT FROM v_acl THEN
   RAISE EXCEPTION 'MTT format lifecycle guard postimage drift';
 END IF;
END $lifecycle_guard$;

-- Keep the real management-event owner and every watched key. Cache each
-- trigger record once; absent OLD/NEW still serializes as NULL for INSERT/DELETE.
DO $row_event_emitter$
DECLARE v_definition text; v_source text; v_acl jsonb; v_owner text;
BEGIN
 SELECT pg_get_functiondef(p.oid),md5(p.prosrc),pg_get_userbyid(p.proowner),
   (SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege',a.privilege_type,'grantable',a.is_grantable)
      ORDER BY a.grantee::regrole::text,a.privilege_type,a.is_grantable)
    FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)
 INTO v_definition,v_source,v_owner,v_acl FROM pg_proc p
 WHERE p.oid=to_regprocedure('public.fn_emit_managed_game_row_event()');
 IF v_source IS DISTINCT FROM 'ae1f5ce76fdfa788200b6f040f71f7cb'
    OR md5(v_definition) IS DISTINCT FROM '2042d20f7a0f3951352069a279e75362'
    OR v_owner IS DISTINCT FROM 'postgres'
    OR v_acl IS DISTINCT FROM '[{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"EXECUTE"},{"grantee":"service_role","grantor":"postgres","grantable":false,"privilege":"EXECUTE"}]'::jsonb THEN
   RAISE EXCEPTION 'MTT format row event emitter preimage drift';
 END IF;
 v_definition:=replace(v_definition,'to_jsonb(NEW)','v_new_document');
 v_definition:=replace(v_definition,'to_jsonb(OLD)','v_old_document');
 v_definition:=replace(v_definition,E'DECLARE\n',
   E'DECLARE\n  v_new_document jsonb := to_jsonb(NEW);\n  v_old_document jsonb := to_jsonb(OLD);\n');
 IF md5(v_definition)<>'9706ead97b5e6f495957bfd02a6eb282' THEN
   RAISE EXCEPTION 'MTT format row event emitter replacement drift';
 END IF;
 EXECUTE v_definition;
 IF (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid='public.fn_emit_managed_game_row_event()'::regprocedure)<>'48b273e03f3b08de4f606f4e07fda0fe'
    OR (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
       WHERE p.oid='public.fn_emit_managed_game_row_event()'::regprocedure)<>'9706ead97b5e6f495957bfd02a6eb282'
    OR (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
       WHERE p.oid='public.fn_emit_managed_game_row_event()'::regprocedure) IS DISTINCT FROM v_owner
    OR (SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
         'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
         'privilege',a.privilege_type,'grantable',a.is_grantable)
         ORDER BY a.grantee::regrole::text,a.privilege_type,a.is_grantable)
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
        WHERE p.oid='public.fn_emit_managed_game_row_event()'::regprocedure) IS DISTINCT FROM v_acl THEN
   RAISE EXCEPTION 'MTT format row event emitter postimage drift';
 END IF;
END $row_event_emitter$;

CREATE TABLE public.ca_mtt_admission_contract (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  abi text NOT NULL CHECK(abi IN ('legacy-capacity-v1','unlimited-mtt-v2'))
);
ALTER TABLE public.ca_mtt_admission_contract OWNER TO postgres;
REVOKE ALL ON TABLE public.ca_mtt_admission_contract FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.ca_mtt_admission_contract ENABLE ROW LEVEL SECURITY;
INSERT INTO public.ca_mtt_admission_contract(singleton,abi) VALUES(true,'legacy-capacity-v1');

CREATE FUNCTION public.fn_ca_guard_mtt_admission_contract() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.singleton IS NOT DISTINCT FROM OLD.singleton AND NEW.abi IS NOT DISTINCT FROM OLD.abi THEN
      RETURN NEW;
    END IF;
    IF OLD.singleton IS TRUE AND NEW.singleton IS TRUE
       AND OLD.abi='legacy-capacity-v1' AND NEW.abi='unlimited-mtt-v2' THEN
      -- The owning admission functions are deliberately not changed here.
      -- A later preparation must install their exact activation proof before
      -- a separate one-way, row-only activation transaction can be admitted.
      RAISE EXCEPTION 'MTT_ADMISSION_ACTIVATION_NOT_PREPARED' USING ERRCODE='55000';
    END IF;
  END IF;
  RAISE EXCEPTION 'MTT_ADMISSION_CONTRACT_IMMUTABLE' USING ERRCODE='55000';
END $function$;
ALTER FUNCTION public.fn_ca_guard_mtt_admission_contract() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_mtt_admission_contract() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ca_mtt_admission_contract_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.ca_mtt_admission_contract
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_mtt_admission_contract();
CREATE TRIGGER ca_mtt_admission_contract_no_truncate
BEFORE TRUNCATE ON public.ca_mtt_admission_contract
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_guard_mtt_admission_contract();

CREATE FUNCTION public.fn_ca_lock_mtt_admission_contract() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE v_abi text;
BEGIN
  SELECT abi INTO v_abi FROM public.ca_mtt_admission_contract WHERE singleton FOR SHARE;
  IF NOT FOUND OR v_abi NOT IN ('legacy-capacity-v1','unlimited-mtt-v2') THEN
    RAISE EXCEPTION 'MTT_ADMISSION_CONTRACT_MISSING_OR_UNKNOWN' USING ERRCODE='55000';
  END IF;
  RETURN v_abi;
END $function$;
ALTER FUNCTION public.fn_ca_lock_mtt_admission_contract() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_lock_mtt_admission_contract() FROM PUBLIC,anon,authenticated,service_role;

-- Narrow recorded legacy shapes, not a new-config classifier. Unknown and
-- contradictory identities deliberately return NULL. is_xmtt is not evidence
-- against an explicit SNG/Spin format. Numeric max_players=2 alone proves none.
CREATE FUNCTION public.fn_ca_legacy_tournament_format(p_row jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $function$
  SELECT CASE
    WHEN upper(p_row->>'tournament_type')='SPIN' AND lower(p_row->>'variant')='spin'
      AND p_row->>'max_players'='3'
      AND NULLIF(p_row->>'satellite_target_id','') IS NULL
      AND NULLIF(p_row->>'satellite_target','') IS NULL THEN 'spin-v1'
    WHEN upper(p_row->>'tournament_type')='SNG' AND lower(p_row->>'variant')='sng'
      AND CASE WHEN coalesce(p_row->>'max_players','')~'^[0-9]+$'
               THEN (p_row->>'max_players')::numeric>=2 ELSE false END
      AND NULLIF(p_row->>'satellite_target_id','') IS NULL
      AND NULLIF(p_row->>'satellite_target','') IS NULL THEN 'sng-v1'
    WHEN upper(p_row->>'tournament_type')='SATELLITE' AND lower(p_row->>'variant')='sng'
      AND p_row->>'max_players'='2' AND p_row->>'min_players'='2'
      AND p_row->>'table_size'='2'
      AND coalesce(NULLIF(p_row->>'satellite_target_id',''),NULLIF(p_row->>'satellite_target','')) IS NOT NULL
      AND (NULLIF(p_row->>'satellite_target_id','') IS NULL
           OR NULLIF(p_row->>'satellite_target','') IS NULL
           OR p_row->>'satellite_target_id'=p_row->>'satellite_target')
      THEN 'seat-first-satellite-v1'
    WHEN upper(p_row->>'tournament_type') IN ('MTT','XMTT')
      AND lower(p_row->>'variant') IN
        ('freezeout','rebuy','reentry','bounty','progressive_bounty','mystery_bounty','satellite','mtt')
      AND CASE WHEN coalesce(p_row->>'max_players','')~'^[0-9]+$'
               THEN (p_row->>'max_players')::numeric>2 ELSE false END THEN 'mtt-v1'
    ELSE NULL END
$function$;
ALTER FUNCTION public.fn_ca_legacy_tournament_format(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_tournament_format(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_tournament_format_identity(p_row jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $function$
  SELECT jsonb_build_object(
    'id',p_row->'id','club_id',p_row->'club_id','union_id',p_row->'union_id',
    'tournament_type',p_row->'tournament_type','variant',p_row->'variant',
    'max_players',p_row->'max_players','min_players',p_row->'min_players',
    'table_size',p_row->'table_size',
    'satellite_target_id',p_row->'satellite_target_id','satellite_target',p_row->'satellite_target')
$function$;
ALTER FUNCTION public.fn_ca_tournament_format_identity(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_format_identity(jsonb) FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.tournaments ADD COLUMN format_contract text;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_format_contract_known
CHECK(format_contract IS NULL OR format_contract IN
 ('mtt-v1','mtt-v2','seat-first-satellite-v1','sng-v1','spin-v1'));

-- Metadata qualification is explicitly performed in finite ID batches after
-- this short DDL transaction commits. Its exact original provenance remains
-- authoritative in this private helper and in the format trigger below.
CREATE FUNCTION public.fn_ca_proven_legacy_tournament_format(p_row jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
 SELECT public.fn_ca_legacy_tournament_format(p_row)
 WHERE p_row->>'status' IN ('ANNOUNCED','REGISTERING','LATE_REG','RUNNING')
   AND EXISTS(SELECT 1 FROM public.managed_game_contract_versions v
     WHERE v.game_kind='tournament' AND v.game_id=(p_row->>'id')::uuid AND v.version=1
       AND v.change_reason='created' AND v.published_at=(p_row->>'created_at')::timestamptz
       AND v.contract_hash=public.fn_managed_game_contract_hash(v.contract)
       AND v.club_id=(p_row->>'club_id')::uuid
       AND v.union_id IS NOT DISTINCT FROM (p_row->>'union_id')::uuid
       AND public.fn_ca_tournament_format_identity(v.contract)
         =public.fn_ca_tournament_format_identity(p_row))
   AND NOT EXISTS(SELECT 1 FROM public.managed_game_contract_versions h
     WHERE h.game_kind='tournament' AND h.game_id=(p_row->>'id')::uuid AND (
       h.contract_hash IS DISTINCT FROM public.fn_managed_game_contract_hash(h.contract)
       OR public.fn_ca_tournament_format_identity(h.contract)
         IS DISTINCT FROM public.fn_ca_tournament_format_identity(p_row)))
   AND NOT EXISTS(SELECT 1 FROM public.tournament_players p
     WHERE p.tournament_id=(p_row->>'id')::uuid AND p.registered_at<(p_row->>'created_at')::timestamptz)
   AND NOT EXISTS(SELECT 1 FROM public.tournament_launch_receipts r
     WHERE r.tournament_id=(p_row->>'id')::uuid
       AND (r.claimed_at<(p_row->>'created_at')::timestamptz
         OR r.started_at<(p_row->>'created_at')::timestamptz))
$function$;
ALTER FUNCTION public.fn_ca_proven_legacy_tournament_format(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_proven_legacy_tournament_format(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_guard_tournament_format() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE v_format text; v_abi text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.format_contract IS NOT NULL THEN
      RAISE EXCEPTION 'TOURNAMENT_FORMAT_IS_DATABASE_ASSIGNED' USING ERRCODE='22023';
    END IF;
    v_abi:=public.fn_ca_lock_mtt_admission_contract();
    IF v_abi<>'legacy-capacity-v1' THEN
      RAISE EXCEPTION 'MTT_FORMAT_V2_CREATOR_NOT_PREPARED' USING ERRCODE='55000';
    END IF;
    v_format:=public.fn_ca_legacy_tournament_format(to_jsonb(NEW));
    IF v_format IS NULL THEN
      RAISE EXCEPTION 'TOURNAMENT_LEGACY_FORMAT_AMBIGUOUS' USING ERRCODE='23514';
    END IF;
    NEW.format_contract:=v_format;
    RETURN NEW;
  END IF;
  IF OLD.format_contract IS NULL AND NEW.format_contract IS NOT NULL THEN
    -- This is provenance qualification, never a caller-selected exemption.
    -- All existing business fields and all origin guards retain authority.
    IF (to_jsonb(NEW)-'format_contract') IS DISTINCT FROM (to_jsonb(OLD)-'format_contract') THEN
      RAISE EXCEPTION 'MTT_FORMAT_METADATA_BACKFILL_CHANGED_BUSINESS_ROW' USING ERRCODE='55000';
    END IF;
    v_abi:=public.fn_ca_lock_mtt_admission_contract();
    v_format:=public.fn_ca_proven_legacy_tournament_format(to_jsonb(OLD));
    IF v_abi<>'legacy-capacity-v1' OR v_format IS NULL
       OR NEW.format_contract IS DISTINCT FROM v_format THEN
      RAISE EXCEPTION 'TOURNAMENT_FORMAT_IMMUTABLE' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.format_contract IS DISTINCT FROM OLD.format_contract THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF public.fn_ca_tournament_format_identity(to_jsonb(NEW))
      IS DISTINCT FROM public.fn_ca_tournament_format_identity(to_jsonb(OLD))
     AND (OLD.format_contract IS NULL
          OR public.fn_ca_legacy_tournament_format(to_jsonb(NEW)) IS DISTINCT FROM OLD.format_contract) THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_IDENTITY_CONFLICT' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_guard_tournament_format() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_tournament_format() FROM PUBLIC,anon,authenticated,service_role;
-- Final BEFORE INSERT position sees any existing authoritative normalization.
CREATE TRIGGER zzzzzzz_tournaments_record_format
BEFORE INSERT OR UPDATE OF format_contract,tournament_type,variant,max_players,min_players,table_size,satellite_target_id,satellite_target,club_id,union_id
ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_tournament_format();

CREATE FUNCTION public.fn_ca_tournament_recorded_format(p_tournament_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE v_format text;
BEGIN
  SELECT format_contract INTO v_format FROM public.tournaments WHERE id=p_tournament_id;
  IF NOT FOUND OR v_format IS NULL OR v_format NOT IN
     ('mtt-v1','mtt-v2','seat-first-satellite-v1','sng-v1','spin-v1') THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_NOT_PROVEN' USING ERRCODE='55000';
  END IF;
  RETURN v_format;
END $function$;
ALTER FUNCTION public.fn_ca_tournament_recorded_format(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_recorded_format(uuid) FROM PUBLIC,anon,authenticated,service_role;

COMMENT ON COLUMN public.tournaments.format_contract IS
 'Database-owned immutable event format; NULL is unresolved historical provenance, never a capacity exemption.';
COMMENT ON TABLE public.ca_mtt_admission_contract IS
 'Private admission ABI. Preparation leaves legacy behavior; unlimited activation is not yet prepared.';
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES ('tournaments','zzzzzzz_tournaments_record_format','Records immutable proven tournament format; no financial mutation or capacity activation.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;
COMMIT;
