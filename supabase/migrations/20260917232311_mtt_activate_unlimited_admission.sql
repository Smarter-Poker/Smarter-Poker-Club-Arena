-- Row-only one-way activation. Install only after compatible application
-- publication and verified retirement of old untagged writers. Database state
-- cannot attest remote process retirement; the existing release proof owns it.
-- No DDL or parent/financial mutations occur in this transaction.
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
SELECT pg_advisory_xact_lock_shared(530090,1);
-- This private singleton relation lock is compatible with all existing ABI
-- readers. Hold it before checking trigger attachments so ALTER TABLE cannot
-- remove/disable the proof between its readback and the one-row UPDATE.
LOCK TABLE public.ca_mtt_admission_contract IN ROW EXCLUSIVE MODE;
DO $activate$ DECLARE v_rows integer; BEGIN
 IF (SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgname)
      FROM pg_trigger t WHERE t.tgrelid='public.ca_mtt_admission_contract'::regclass AND NOT t.tgisinternal)
    IS DISTINCT FROM $attachments$[["ca_mtt_admission_contract_immutable","CREATE TRIGGER ca_mtt_admission_contract_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.ca_mtt_admission_contract FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()","O"],["ca_mtt_admission_contract_no_truncate","CREATE TRIGGER ca_mtt_admission_contract_no_truncate BEFORE TRUNCATE ON public.ca_mtt_admission_contract FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()","O"]]$attachments$::jsonb THEN
  RAISE EXCEPTION 'MTT_ACTIVATION_GUARD_ATTACHMENT_DRIFT' USING ERRCODE='55000';
 END IF;
 IF current_user<>'postgres' OR current_setting('session_replication_role')<>'origin'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_guard_mtt_admission_contract()'))
       IS DISTINCT FROM 'c7656b0d33a730e39d9ad22dd10d497d'
    OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_guard_mtt_admission_contract()')
       AND p.prosecdef AND p.provolatile='v' AND p.prorettype='trigger'::regtype
       AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
       AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[])
    OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_guard_mtt_admission_contract()')) IS DISTINCT FROM 'postgres'
    OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_proc p CROSS JOIN LATERAL
       unnest(coalesce(p.proacl,acldefault('f',p.proowner)))a
       WHERE p.oid=to_regprocedure('public.fn_ca_guard_mtt_admission_contract()')) IS DISTINCT FROM ARRAY['postgres=X/postgres']::text[] THEN
  RAISE EXCEPTION 'MTT_ACTIVATION_GUARD_IDENTITY_DRIFT' USING ERRCODE='55000';
 END IF;
 UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2'
   WHERE singleton AND abi='legacy-capacity-v1';
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 IF v_rows<>1 THEN
  RAISE EXCEPTION 'MTT_ACTIVATION_EXPECTED_EXACTLY_ONE_LEGACY_CONTRACT' USING ERRCODE='55000';
 END IF;
END $activate$;
COMMIT;
