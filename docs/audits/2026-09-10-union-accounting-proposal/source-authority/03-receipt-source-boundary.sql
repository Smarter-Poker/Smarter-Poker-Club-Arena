-- PROPOSAL ONLY. Same transaction as prospective cash admission.
-- The accepted owner body and signature remain unchanged. Existing rows receive
-- no marker; only inserts after this transaction can enter source capture.
DO $preflight$
DECLARE v_oid oid;
BEGIN
 v_oid:=to_regprocedure('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)');
 IF v_oid IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)
    IS DISTINCT FROM '0ef3c57a6a31acc383ce4b95a0f9519f'
    OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
    OR has_function_privilege('anon',v_oid,'execute')
    OR has_function_privilege('authenticated',v_oid,'execute')
    OR NOT has_function_privilege('service_role',v_oid,'execute') THEN
   RAISE EXCEPTION 'Accepted owner body or execution boundary changed';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
    'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure)
    IS DISTINCT FROM 'e67e89b3aec325f8038e0507a1511eec'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_allocate_rake_credits(numeric,jsonb,text)'::regprocedure)
    IS DISTINCT FROM 'a63ce6760dc4178f000f2214a7cf7cd6' THEN
   RAISE EXCEPTION 'Accepted stack request or allocator changed';
 END IF;
END $preflight$;
ALTER TABLE public.hand_atomic_commits ADD COLUMN commission_capture_version integer
 CHECK(commission_capture_version IS NULL OR commission_capture_version=1);
-- Adding without a default leaves historical NULL and non-NULL envelopes NULL.
ALTER TABLE public.hand_atomic_commits ALTER COLUMN commission_capture_version SET DEFAULT 1;
CREATE FUNCTION public.fn_ca_cash_commission_marker_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN
 IF NEW.commission_capture_version IS DISTINCT FROM OLD.commission_capture_version THEN
   RAISE EXCEPTION 'Cash commission capture generation is immutable';
 END IF;
 RETURN NEW;
END $f$;
CREATE FUNCTION public.fn_ca_capture_first_cash_envelope() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_owner name;
BEGIN
 IF NEW.commission_capture_version IS DISTINCT FROM 1 THEN RETURN NULL; END IF;
 IF (coalesce(jsonb_typeof(NEW.post_commit_payload->'rake'),'null')<>'object'
     OR nullif(NEW.post_commit_payload->'rake'->>'tournament_id','') IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM public.ca_cash_commission_sources WHERE hand_id=NEW.hand_id) THEN
   RETURN NULL;
 END IF;
 IF TG_OP='UPDATE' AND OLD.post_commit_payload IS NOT NULL THEN
   IF NEW.post_commit_payload IS DISTINCT FROM OLD.post_commit_payload
      OR NEW.post_commit_payload_hash IS DISTINCT FROM OLD.post_commit_payload_hash THEN
     RAISE EXCEPTION 'Captured cash commission envelope is immutable';
   END IF;
   RETURN NULL;
 END IF;
 IF NEW.post_commit_payload IS NULL THEN RETURN NULL; END IF;
 SELECT pg_get_userbyid(proowner) INTO STRICT v_owner FROM pg_proc
 WHERE oid='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure;
 IF current_user IS DISTINCT FROM v_owner THEN
   RAISE EXCEPTION 'Only the accepted hand owner may capture commission facts'
     USING ERRCODE='42501';
 END IF;
 IF jsonb_typeof(NEW.stack_result->'request'->'stacks') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Accepted receipt omitted exact stack request';
 END IF;
 PERFORM public.fn_ca_capture_cash_commission_source(NEW.hand_id,NEW.stack_result->'request'->'stacks');
 RETURN NULL;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_cash_commission_marker_immutable(),
 public.fn_ca_capture_first_cash_envelope() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ca_cash_commission_marker_immutable BEFORE UPDATE OF commission_capture_version
 ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_commission_marker_immutable();
CREATE TRIGGER ca_capture_first_cash_envelope AFTER INSERT OR UPDATE OF post_commit_payload,post_commit_payload_hash
 ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION public.fn_ca_capture_first_cash_envelope();
INSERT INTO public.ca_cash_commission_authority(singleton,contract_version,activated_at,
 accepted_owner_before_md5,accepted_owner_after_md5)
SELECT true,1,clock_timestamp(),md5(prosrc),md5(prosrc) FROM pg_proc
WHERE oid='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure;
