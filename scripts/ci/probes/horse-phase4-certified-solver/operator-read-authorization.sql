BEGIN;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role',true),'')
$$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
CREATE OR REPLACE FUNCTION public.fn_is_horse_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT auth.uid()='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid
$$;

DO $probe$
DECLARE
  blocked boolean;
  v_name text;
  v_open text;
BEGIN
  -- A service worker has no user identity. The role claim itself is the gate.
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM 1 FROM public.ca_horse_solver_agreement(14);
  PERFORM 1 FROM public.ca_horse_solver_agreement_decisions(NULL,'gto_charts',100);
  PERFORM public.ca_solver_pipeline_liveness();

  -- The one fixture admin is admitted through the same path used by PostgREST.
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  PERFORM 1 FROM public.ca_horse_solver_agreement(14);
  PERFORM 1 FROM public.ca_horse_solver_agreement_decisions(NULL,'gto_charts',100);
  PERFORM public.ca_solver_pipeline_liveness();

  -- An authenticated non-admin must be rejected by every Phase 4 operator read.
  PERFORM set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
  FOREACH v_name IN ARRAY ARRAY[
    'agreement summary',
    'agreement decisions',
    'pipeline liveness'
  ] LOOP
    blocked := false;
    BEGIN
      CASE v_name
        WHEN 'agreement summary' THEN
          PERFORM 1 FROM public.ca_horse_solver_agreement(14);
        WHEN 'agreement decisions' THEN
          PERFORM 1 FROM public.ca_horse_solver_agreement_decisions(NULL,'gto_charts',100);
        WHEN 'pipeline liveness' THEN
          PERFORM public.ca_solver_pipeline_liveness();
      END CASE;
    EXCEPTION WHEN OTHERS THEN
      blocked := SQLERRM='admin only';
    END;
    IF NOT blocked THEN
      RAISE EXCEPTION 'non-admin reached Phase 4 %',v_name;
    END IF;
  END LOOP;

  IF has_function_privilege('anon','public.ca_horse_solver_agreement(integer)','EXECUTE')
     OR has_function_privilege('anon','public.ca_horse_solver_agreement_decisions(date,text,integer)','EXECUTE')
     OR has_function_privilege('anon','public.ca_solver_pipeline_liveness()','EXECUTE') THEN
    RAISE EXCEPTION 'anon retains EXECUTE on a Phase 4 operator read';
  END IF;

  SELECT string_agg(t.proname,', ' ORDER BY t.proname) INTO v_open
    FROM public.fn_ca_browser_reachable_telemetry() t
   WHERE t.proname IN (
     'ca_horse_solver_agreement',
     'ca_horse_solver_agreement_decisions',
     'ca_solver_pipeline_liveness'
   );
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'telemetry guard still reports Phase 4 operator reads: %',v_open;
  END IF;
END;
$probe$;
ROLLBACK;
SELECT 'OPERATOR_READ_AUTHORIZATION_OK' AS result;
