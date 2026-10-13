-- Draft source. No runtime installation or admission has been performed.
CREATE TABLE smarter_private.original_inventory_restoration_cases(
 event_id bigint PRIMARY KEY,source_name text NOT NULL,row_id uuid NOT NULL,
 original_witness jsonb NOT NULL,witness_md5 text NOT NULL CHECK(witness_md5 ~ '^[0-9a-f]{32}$'),
 family text NOT NULL CHECK(family IN('paired_player','paired_chair','closed_player','continued_chair','returned_cash','erased_cash_receivable')),
 source_refs jsonb NOT NULL CHECK(jsonb_typeof(source_refs)='array' AND jsonb_array_length(source_refs)>0),
 CHECK(source_name IN('tournament_players','table_seats')),CHECK(witness_md5=md5(original_witness::text)));
CREATE TABLE smarter_private.original_inventory_restoration_certificates(
 event_id bigint NOT NULL,boundary timestamptz NOT NULL,
 witness_md5 text NOT NULL,original_witness jsonb NOT NULL,proof jsonb NOT NULL,proof_md5 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(event_id,boundary),CHECK(boundary='2026-10-12 07:00:00Z'::timestamptz),
 CHECK(witness_md5 ~ '^[0-9a-f]{32}$' AND witness_md5=md5(original_witness::text) AND proof_md5=md5(proof::text)));
ALTER TABLE smarter_private.original_inventory_restoration_cases OWNER TO postgres;
ALTER TABLE smarter_private.original_inventory_restoration_certificates OWNER TO postgres;
ALTER TABLE smarter_private.original_inventory_restoration_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.original_inventory_restoration_certificates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.original_inventory_restoration_cases,
 smarter_private.original_inventory_restoration_certificates FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.original_inventory_restoration_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN RAISE EXCEPTION 'original_inventory_restoration_evidence_is_immutable' USING ERRCODE='55000';END $body$;
REVOKE ALL ON FUNCTION smarter_private.original_inventory_restoration_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_restoration_case_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON smarter_private.original_inventory_restoration_cases FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.original_inventory_restoration_immutable();
CREATE TRIGGER original_restoration_certificate_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON smarter_private.original_inventory_restoration_certificates FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.original_inventory_restoration_immutable();

CREATE FUNCTION smarter_private.certify_original_inventory_restoration(p_event_id bigint,p_boundary timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $body$
DECLARE expected text; family text; witness jsonb; proof jsonb;
BEGIN
 IF session_user IS DISTINCT FROM 'postgres' OR current_user IS DISTINCT FROM 'postgres'
 OR nullif(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'original_inventory_certificate_caller_refused' USING ERRCODE='42501';END IF;
 IF p_event_id IS NULL OR p_boundary IS DISTINCT FROM '2026-10-12 07:00:00Z'::timestamptz
 OR public.fn_platform_frozen() IS DISTINCT FROM false
 OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'original_inventory_certificate_boundary_refused' USING ERRCODE='55000';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-pnl-original-inventory-restoration',0)) THEN
  RAISE EXCEPTION 'original_inventory_certificate_writer_busy' USING ERRCODE='55000';END IF;
 SELECT witness_md5,k.family INTO expected,family FROM smarter_private.original_inventory_restoration_cases k WHERE event_id=p_event_id;
 IF expected IS NULL OR EXISTS(SELECT 1 FROM smarter_private.original_inventory_restoration_certificates
 WHERE event_id=p_event_id AND boundary=p_boundary) THEN
  RAISE EXCEPTION 'original_inventory_certificate_unknown_or_replayed' USING ERRCODE='55000';END IF;
 witness:=smarter_private.original_inventory_finite_witness(p_event_id);
 IF witness IS NULL OR md5(witness::text) IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'original_inventory_certificate_witness_changed' USING ERRCODE='55000';END IF;
 proof:=smarter_private.original_inventory_finite_family_proof(family,witness,'2026-10-05 07:00:00Z',p_boundary);
 IF proof->>'status' IS DISTINCT FROM 'ready' OR proof->'financial_admission' IS DISTINCT FROM 'false'::jsonb THEN
  RAISE EXCEPTION 'original_inventory_certificate_proof_refused' USING ERRCODE='55000';END IF;
 INSERT INTO smarter_private.original_inventory_restoration_certificates(event_id,boundary,witness_md5,original_witness,proof,proof_md5)
 VALUES(p_event_id,p_boundary,expected,witness,proof,md5(proof::text));
 RETURN jsonb_build_object('original_inventory_certificate',true,'event_id',p_event_id,'boundary',p_boundary,
  'witness_md5',expected,'proof_md5',md5(proof::text),'financial_payment',false);
END $body$;
ALTER FUNCTION smarter_private.certify_original_inventory_restoration(bigint,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.certify_original_inventory_restoration(bigint,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.inventory_restoration_issue_accepted(issue jsonb,p_boundary timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $body$
DECLARE event bigint; witness jsonb; proof jsonb; c record;
BEGIN
 IF jsonb_typeof(issue) IS DISTINCT FROM 'object' OR issue->>'reason' IS DISTINCT FROM 'original_inventory_chain_disagrees'
 OR issue->>'source_name' NOT IN('tournament_players','table_seats') OR issue->>'source_name' IS NULL
 OR issue->>'source_event_id' IS NULL OR issue->>'source_event_id' !~ '^[0-9]+$'
 OR p_boundary IS NULL OR NOT isfinite(p_boundary) OR p_boundary<'2026-10-12 07:00:00Z'::timestamptz THEN RETURN false;END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RETURN false;END IF;
 event:=(issue->>'source_event_id')::bigint;
 SELECT r.*,k.source_name,k.row_id,k.family,k.witness_md5 expected_md5 INTO c
 FROM smarter_private.original_inventory_restoration_certificates r
 JOIN smarter_private.original_inventory_restoration_cases k USING(event_id)
 WHERE r.event_id=event AND r.boundary='2026-10-12 07:00:00Z'::timestamptz;
 IF NOT FOUND OR issue->>'row_id' IS DISTINCT FROM c.row_id::text
 OR issue->>'source_name' IS DISTINCT FROM c.source_name OR c.witness_md5 IS DISTINCT FROM c.expected_md5
 OR c.witness_md5 IS DISTINCT FROM md5(c.original_witness::text) OR c.proof_md5 IS DISTINCT FROM md5(c.proof::text) THEN RETURN false;END IF;
 witness:=smarter_private.original_inventory_finite_witness(event);
 IF witness IS NULL OR md5(witness::text) IS DISTINCT FROM c.expected_md5 THEN RETURN false;END IF;
 proof:=smarter_private.original_inventory_finite_family_proof(c.family,witness,'2026-10-05 07:00:00Z','2026-10-12 07:00:00Z');
 RETURN proof->>'status'='ready' AND proof->'financial_admission'='false'::jsonb
  AND proof IS NOT DISTINCT FROM c.proof AND md5(proof::text)=c.proof_md5;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $body$;
ALTER FUNCTION smarter_private.inventory_restoration_issue_accepted(jsonb,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.inventory_restoration_issue_accepted(jsonb,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.original_inventory_certificate_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $body$
DECLARE c record;w jsonb;p jsonb;
BEGIN
 IF session_user IS DISTINCT FROM 'postgres' OR current_user IS DISTINCT FROM 'postgres'
 OR nullif(current_setting('request.jwt.claim.role',true),'') IS NOT NULL
 OR NEW.boundary IS DISTINCT FROM '2026-10-12 07:00:00Z'::timestamptz
 OR public.fn_platform_frozen() IS DISTINCT FROM false
 OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true
 OR NOT pg_try_advisory_xact_lock(hashtextextended('union-pnl-original-inventory-restoration',0)) THEN
 RAISE EXCEPTION 'original_inventory_certificate_insert_caller_refused' USING ERRCODE='55000';END IF;
 SELECT * INTO c FROM smarter_private.original_inventory_restoration_cases WHERE event_id=NEW.event_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'original_inventory_certificate_case_refused' USING ERRCODE='55000';END IF;
 w:=smarter_private.original_inventory_finite_witness(NEW.event_id);
 p:=smarter_private.original_inventory_finite_family_proof(c.family,w,'2026-10-05 07:00:00Z',NEW.boundary);
 IF w IS NULL OR NEW.original_witness IS DISTINCT FROM w OR NEW.witness_md5 IS DISTINCT FROM c.witness_md5
 OR md5(w::text) IS DISTINCT FROM c.witness_md5 OR p->>'status' IS DISTINCT FROM 'ready'
 OR p->'financial_admission' IS DISTINCT FROM 'false'::jsonb
 OR NEW.proof IS DISTINCT FROM p OR NEW.proof_md5 IS DISTINCT FROM md5(p::text) THEN
 RAISE EXCEPTION 'original_inventory_certificate_canonical_reproof_refused' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $body$;
ALTER FUNCTION smarter_private.original_inventory_certificate_insert_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_inventory_certificate_insert_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER finite_original_inventory_certificate_insert BEFORE INSERT ON smarter_private.original_inventory_restoration_certificates
 FOR EACH ROW EXECUTE FUNCTION smarter_private.original_inventory_certificate_insert_guard();
