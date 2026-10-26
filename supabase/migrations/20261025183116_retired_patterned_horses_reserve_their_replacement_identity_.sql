-- Reserved by scripts/new-migration.mjs: 20261025183116.
-- Finite original-cohort metadata only. No auth, profile, money, seat, membership,
-- ledger or retired identity is changed. All DDL is one transaction.
-- @live-proof: to_regprocedure('public.fn_reserve_patterned_horse_replacements(boolean)') IS NOT NULL AND has_function_privilege('service_role','public.fn_reserve_patterned_horse_replacements(boolean)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_reserve_patterned_horse_replacements(boolean)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_reserve_patterned_horse_replacements(boolean)','EXECUTE') AND (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('public.fn_reserve_patterned_horse_replacements(boolean)'))='e52c3764d7c709cd97b93ac0ca86de62' AND EXISTS(SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid=to_regclass('smarter_private.patterned_retirement_replacement_identity_once') AND indisunique AND indisvalid AND indisready) AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=to_regclass('smarter_private.patterned_identity_retirements') AND tgname='patterned_replacement_identity_is_original' AND tgenabled='O') AND EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=to_regclass('smarter_private.patterned_horse_replacement_batch') AND relrowsecurity)

BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
CREATE UNIQUE INDEX patterned_retirement_replacement_identity_once
 ON smarter_private.patterned_identity_retirements(replacement_horse_id)
 WHERE replacement_horse_id IS NOT NULL;
CREATE TABLE smarter_private.patterned_horse_replacement_batch (
 batch text PRIMARY KEY CHECK(batch='patterned-retirement-20261006'),
 initial_active_count integer NOT NULL, initial_active_md5 text NOT NULL,
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE smarter_private.patterned_horse_replacement_batch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.patterned_horse_replacement_batch FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.patterned_replacement_identity_is_original()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $guard$
BEGIN
 IF OLD.replacement_horse_id IS NOT NULL AND
   (TG_OP='DELETE' OR NEW.replacement_horse_id IS DISTINCT FROM OLD.replacement_horse_id) THEN
  RAISE EXCEPTION 'original replacement identity is immutable';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION smarter_private.patterned_replacement_identity_is_original() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER patterned_replacement_identity_is_original
 BEFORE UPDATE OF replacement_horse_id OR DELETE ON smarter_private.patterned_identity_retirements
 FOR EACH ROW EXECUTE FUNCTION smarter_private.patterned_replacement_identity_is_original();
CREATE FUNCTION public.fn_reserve_patterned_horse_replacements(p_reserve boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
DECLARE cohort_count integer; cohort_hash text; originals_ok integer; existing_other integer;
 reservation_row record; candidate uuid; replacements jsonb; completed integer; active_count integer; roster_count integer;
 original_digest text; baseline smarter_private.patterned_horse_replacement_batch%ROWTYPE;
BEGIN
 IF p_reserve IS NULL THEN RAISE EXCEPTION 'replacement reservation mode required'; END IF;
 -- One original cohort; independent of roster refresh or financial locks.
 IF p_reserve THEN
  PERFORM pg_advisory_xact_lock(hashtext('patterned-retirement-20261006-replacements'));
 END IF;
 SELECT count(*),md5(string_agg(old_id::text,',' ORDER BY old_id))
 INTO cohort_count,cohort_hash FROM smarter_private.patterned_identity_retirements
 WHERE cohort='horse' AND retired_at IS NOT NULL;
 IF (cohort_count,cohort_hash) IS DISTINCT FROM (62,'cd746293f12b88be4f1a42cfa7a28316') THEN
  RAISE EXCEPTION 'original completed replacement cohort changed';
 END IF;
 SELECT count(*) INTO originals_ok FROM smarter_private.patterned_identity_retirements r
 JOIN public.profiles p ON p.id=r.old_id
 JOIN public.ca_horse_fleet_register f ON f.horse_id=r.old_id
 WHERE r.cohort='horse' AND r.retired_at IS NOT NULL AND p.is_horse IS TRUE
 AND p.status='deleted' AND p.horse_status='disabled' AND f.retired_at IS NOT NULL;
 IF originals_ok<>62 THEN RAISE EXCEPTION 'retired original identity changed'; END IF;
 SELECT count(*),md5(string_agg(p.id::text,',' ORDER BY p.id)) INTO existing_other,original_digest FROM public.profiles p
 JOIN public.ca_horse_fleet_register f ON f.horse_id=p.id AND f.retired_at IS NULL
 WHERE p.is_horse IS TRUE AND coalesce(p.status,'active')='active'
 AND coalesce(p.horse_status,'available')<>'disabled'
 AND NOT EXISTS(SELECT 1 FROM smarter_private.patterned_identity_retirements r
                WHERE r.replacement_horse_id=p.id);
 IF p_reserve THEN
  INSERT INTO smarter_private.patterned_horse_replacement_batch(batch,initial_active_count,initial_active_md5)
  VALUES('patterned-retirement-20261006',existing_other,coalesce(original_digest,md5('')))
  ON CONFLICT(batch) DO NOTHING;
  FOR reservation_row IN SELECT old_id FROM smarter_private.patterned_identity_retirements
   WHERE cohort='horse' AND retired_at IS NOT NULL ORDER BY old_id FOR UPDATE
  LOOP
   IF (SELECT replacement_horse_id FROM smarter_private.patterned_identity_retirements WHERE old_id=reservation_row.old_id) IS NULL THEN
    candidate:=gen_random_uuid();
    IF candidate::text ~ '^(00000000|face0000)-' OR EXISTS(SELECT 1 FROM public.profiles WHERE id=candidate) THEN
      RAISE EXCEPTION 'replacement UUID already exists; no reservation committed';
    END IF;
    UPDATE smarter_private.patterned_identity_retirements SET replacement_horse_id=candidate
     WHERE old_id=reservation_row.old_id AND replacement_horse_id IS NULL;
   END IF;
  END LOOP;
 END IF;
 SELECT * INTO baseline FROM smarter_private.patterned_horse_replacement_batch WHERE batch='patterned-retirement-20261006';
 IF EXISTS(SELECT 1 FROM smarter_private.patterned_identity_retirements
  WHERE cohort='horse' AND replacement_horse_id IS NOT NULL AND
   (replacement_horse_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR replacement_horse_id::text ~ '^(00000000|face0000)-')) THEN
  RAISE EXCEPTION 'invalid original replacement mapping';
 END IF;
 SELECT jsonb_agg(jsonb_build_object('retiredHorseId',old_id,'horseId',replacement_horse_id) ORDER BY old_id)
 INTO replacements FROM smarter_private.patterned_identity_retirements WHERE cohort='horse' AND retired_at IS NOT NULL;
 SELECT count(*) INTO completed FROM smarter_private.patterned_identity_retirements r
 JOIN public.profiles p ON p.id=r.replacement_horse_id
 JOIN public.ca_horse_fleet_register f ON f.horse_id=p.id AND f.retired_at IS NULL
 WHERE r.cohort='horse' AND r.retired_at IS NOT NULL AND p.is_horse IS TRUE
 AND coalesce(p.status,'active')='active' AND coalesce(p.horse_status,'available')<>'disabled';
 SELECT count(*) INTO active_count FROM public.profiles p
 JOIN public.ca_horse_fleet_register f ON f.horse_id=p.id AND f.retired_at IS NULL
 WHERE p.is_horse IS TRUE AND coalesce(p.status,'active')='active'
 AND coalesce(p.horse_status,'available')<>'disabled';
 SELECT count(*) INTO roster_count FROM public.ca_horse_active_roster;
 RETURN jsonb_build_object('batch','patterned-retirement-20261006','target_active',1000,
  'eligible_active',active_count,'active_roster',roster_count,'completed_replacements',completed,'replacements',replacements,
  'initial_active_count',baseline.initial_active_count,'initial_active_md5',baseline.initial_active_md5,
  'current_original_active_count',existing_other,'current_original_active_md5',original_digest,
  'population_changed',baseline.batch IS NOT NULL AND baseline.initial_active_md5 IS DISTINCT FROM original_digest);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_reserve_patterned_horse_replacements(boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_reserve_patterned_horse_replacements(boolean) TO service_role;
COMMIT;
