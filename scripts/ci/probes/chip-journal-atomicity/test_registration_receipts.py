"""Exercise the real registration receipt wrapper; the money core is an isolated test double."""
from pathlib import Path

def verify_registration_receipts(run):
    root = Path(__file__).resolve().parents[4]
    migration = root / "supabase/migrations/20260909210701_tournament_registration_retains_original_operation_receipt.sql"
    run("""
DO $roles$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $roles$;
""")
    run(migration.read_text())
    run(migration.read_text())
    run("""
BEGIN;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
 $f$ SELECT nullif(current_setting('test.registration_uid',true),'')::uuid $f$;
CREATE OR REPLACE FUNCTION public.fn_caller_session_is_live() RETURNS boolean LANGUAGE sql AS
 $f$ SELECT current_setting('test.registration_session',true)='live' $f$;
CREATE TABLE registration_wrapper_calls(n integer);
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(uuid,boolean)
RETURNS jsonb LANGUAGE plpgsql AS $f$
BEGIN
 IF current_setting('test.registration_mode',true)='refuse' THEN
  RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
 END IF;
 INSERT INTO registration_wrapper_calls VALUES(1);
 IF current_setting('test.registration_mode',true)='fail' THEN
  RAISE EXCEPTION 'injected downstream journal failure' USING ERRCODE='XX001';
 END IF;
 RETURN jsonb_build_object('ok',true,
  'registration_id','30000000-0000-4000-8000-000000000001','cost',110);
END $f$;
SELECT set_config('test.registration_uid','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('test.registration_session','live',true);
SELECT set_config('test.registration_mode','normal',true);
DO $verify$
DECLARE
 t uuid := '20000000-0000-4000-8000-000000000001';
 k uuid := '40000000-0000-4000-8000-000000000001';
 r jsonb; replay jsonb; denied boolean;
BEGIN
 r := public.fn_register_for_tournament_request(t,k);
 IF r->>'request_id' <> k::text OR r->>'tournament_id' <> t::text
    OR r->>'user_id' <> auth.uid()::text OR r->>'cost' <> '110' THEN
  RAISE EXCEPTION 'receipt lost original operation fields';
 END IF;
 PERFORM set_config('test.registration_mode','refuse',true);
 replay := public.fn_register_for_tournament_request(t,k);
 IF replay IS DISTINCT FROM r OR (SELECT count(*) FROM registration_wrapper_calls)<>1 THEN
  RAISE EXCEPTION 'replay ran the core or changed the accepted result after a freeze';
 END IF;

 denied:=false;
 BEGIN PERFORM public.fn_register_for_tournament_request(
  '20000000-0000-4000-8000-000000000002',k);
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'same request accepted a different tournament'; END IF;

 PERFORM set_config('test.registration_uid','10000000-0000-4000-8000-000000000002',true);
 denied:=false;
 BEGIN PERFORM public.fn_register_for_tournament_request(t,k);
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'same request accepted a different caller'; END IF;
 PERFORM set_config('test.registration_uid','10000000-0000-4000-8000-000000000001',true);

 PERFORM set_config('test.registration_session','expired',true);
 denied:=false;
 BEGIN PERFORM public.fn_register_for_tournament_request(t,k);
 EXCEPTION WHEN SQLSTATE '28000' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'expired session replayed a receipt'; END IF;
 PERFORM set_config('test.registration_session','live',true);
 denied:=false;
 BEGIN PERFORM public.fn_register_for_tournament_request(t,NULL);
 EXCEPTION WHEN SQLSTATE '22004' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'null key admitted an unbound purchase'; END IF;

 -- A proved refusal owns no debit and must not strand a pending claim.
 k := '40000000-0000-4000-8000-000000000002';
 r := public.fn_register_for_tournament_request(t,k);
 IF r->'ok' IS DISTINCT FROM 'false'::jsonb OR EXISTS(
  SELECT 1 FROM entry_purchase_idempotency_receipts
  WHERE key_domain='tournament_registration_v1' AND idempotency_key=k::text) THEN
  RAISE EXCEPTION 'a precommit refusal retained an incomplete claim';
 END IF;
 PERFORM set_config('test.registration_mode','fail',true);
 denied:=false;
 BEGIN PERFORM public.fn_register_for_tournament_request(t,k);
 EXCEPTION WHEN SQLSTATE 'XX001' THEN denied:=true; END;
 IF NOT denied OR (SELECT count(*) FROM registration_wrapper_calls)<>1
    OR EXISTS(SELECT 1 FROM entry_purchase_idempotency_receipts
      WHERE key_domain='tournament_registration_v1' AND idempotency_key=k::text) THEN
  RAISE EXCEPTION 'downstream failure did not roll back both core and claim';
 END IF;
 PERFORM set_config('test.registration_mode','normal',true);
 r := public.fn_register_for_tournament_request(t,k);
 IF r->'ok' IS DISTINCT FROM 'true'::jsonb OR (SELECT count(*) FROM registration_wrapper_calls)<>2 THEN
  RAISE EXCEPTION 'rolled back request could not complete exactly once';
 END IF;
 IF has_function_privilege('anon','public.fn_register_for_tournament_request(uuid,uuid)','execute')
 OR has_function_privilege('service_role','public.fn_register_for_tournament_request(uuid,uuid)','execute')
 OR NOT has_function_privilege('authenticated','public.fn_register_for_tournament_request(uuid,uuid)','execute') THEN
  RAISE EXCEPTION 'registration request permissions differ from authenticated-only contract';
 END IF;
END $verify$;
ROLLBACK;
""")
    print("registration receipt wrapper: 10 PostgreSQL assertions passed; underlying funding core is a test double", flush=True)
