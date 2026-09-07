DO $probe$
DECLARE src text; j jsonb; tbl text;
 u uuid:='00000000-0000-4000-8000-000000000001';
 other_u uuid:='00000000-0000-4000-8000-000000000002';
BEGIN
 FOREACH tbl IN ARRAY ARRAY['unions','union_wallets','union_wallet_transactions','bbj_pools','clubs','union_clubs','union_rakeback_log','financial_alerts'] LOOP
  EXECUTE format('CREATE TEMP TABLE %I (LIKE public.%I) ON COMMIT DROP',tbl,tbl);
 END LOOP;
 CREATE TEMP TABLE probe_access(union_id uuid) ON COMMIT DROP;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_report_caller_ok(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT EXISTS(SELECT 1 FROM pg_temp.probe_access WHERE union_id=$1)'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.ca_can_oversee_union(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql AS 'SELECT ''2026-09-07 06:00Z''::timestamptz'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_union_treasury_selftest() RETURNS jsonb LANGUAGE sql AS 'SELECT ''{"global_diagnostics_exposed":true}''::jsonb'$f$;
 SELECT pg_get_functiondef('public.fn_union_money_report(uuid)'::regprocedure) INTO src;
 src:=replace(replace(replace(src,'public.','pg_temp.'),'''public''','''pg_temp'''),'fn_union_treasury_selftest()','pg_temp.fn_union_treasury_selftest()'); EXECUTE src;
 BEGIN
  PERFORM pg_temp.fn_union_money_report(u);
  RAISE EXCEPTION 'FAIL unrelated signed-in user can read union report';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 INSERT INTO pg_temp.probe_access VALUES(u);
 INSERT INTO pg_temp.financial_alerts(id,severity,source,message,resolved,context,created_at) VALUES
  (gen_random_uuid(),'critical','probe','own alert',false,jsonb_build_object('union_id',u),now()),
  (gen_random_uuid(),'critical','probe','other union secret',false,jsonb_build_object('union_id',other_u),now()),
  (gen_random_uuid(),'critical','probe','global secret',false,'{}',now());
 j:=pg_temp.fn_union_money_report(u);
 IF jsonb_array_length(j->'open_alerts')<>1 OR j->'open_alerts'->0->>'message'<>'own alert' THEN RAISE EXCEPTION 'FAIL alerts not scoped: %',j; END IF;
 IF j->'selftest'->>'checked' IS DISTINCT FROM 'false' OR j::text LIKE '%global_diagnostics_exposed%' THEN RAISE EXCEPTION 'FAIL report executes global self-test'; END IF;
 BEGIN
  PERFORM pg_temp.fn_union_money_report(other_u);
  RAISE EXCEPTION 'FAIL authorized user reads other union';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 RAISE EXCEPTION 'AUDIT_TEST_PASS: actual union money report rejects unrelated caller and other union, returns only authorized union alerts and does not invoke global self-test. All pg_temp rolled back. Permission helper stubbed, existing real helper inspected separately; no actual caller data returned or changed.';
END;
$probe$;
