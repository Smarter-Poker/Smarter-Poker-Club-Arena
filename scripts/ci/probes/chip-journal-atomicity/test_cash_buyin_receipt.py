"""Run the real read-only receipt RPC with isolated roles and receipt rows."""
from pathlib import Path
import re


def verify_cash_buyin_receipt(run):
 root = Path(__file__).resolve().parents[4]
 migration = (root/'supabase/migrations/20260908192135_cash_buyin_receipt_readback.sql').read_text()
 body = re.sub(r'^(BEGIN|COMMIT);\s*$', '', migration, flags=re.M)
 u = 'd0000000-0000-4000-8000-000000000001'
 t = 'b0000000-0000-4000-8000-000000000001'
 k = 'c0000000-0000-4000-8000-000000000001'
 other = 'a0000000-0000-4000-8000-000000000001'
 fixture = """
 DO $$BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
 END$$;
 CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$SELECT nullif(current_setting('test.receipt_user',true),'')::uuid$$;
 CREATE OR REPLACE FUNCTION public.fn_caller_session_is_live() RETURNS boolean
 LANGUAGE sql STABLE AS $$SELECT current_setting('test.receipt_live',true)='true'$$;
 ALTER TABLE public.entry_purchase_idempotency_receipts ENABLE ROW LEVEL SECURITY;
 REVOKE ALL ON public.entry_purchase_idempotency_receipts FROM PUBLIC,anon,authenticated,service_role;
 """
 request = f"jsonb_build_object('door','atomic_table_buyin','user_id','{u}','table_id','{t}','seat_number',2,'amount',100,'auto_rebuy',false,'club_id',NULL)"
 call = f"public.fn_ca_cash_buyin_receipt('{k}','{t}')"
 cases = 0
 for label,domain,key,req,response,completed,expected in [
  ('confirmed','cash_transaction',k,request,"'{\"completed\":true}'::jsonb",'now()','confirmed'),
  ('other member','cash_transaction',k,request+f" || jsonb_build_object('user_id','{other}')","'{\"completed\":true}'::jsonb",'now()','unconfirmed'),
  ('other table','cash_transaction',k,request+f" || jsonb_build_object('table_id','{other}')","'{\"completed\":true}'::jsonb",'now()','unconfirmed'),
  ('other door','cash_transaction',k,request+" || jsonb_build_object('door','other')","'{\"completed\":true}'::jsonb",'now()','unconfirmed'),
  ('other domain','other',k,request,"'{\"completed\":true}'::jsonb",'now()','unconfirmed'),
  ('other key','cash_transaction',other,request,"'{\"completed\":true}'::jsonb",'now()','unconfirmed'),
  ('unfinished response','cash_transaction',k,request,'NULL','NULL','unconfirmed'),
  ('missing completion','cash_transaction',k,request,"'{\"completed\":true}'::jsonb",'NULL','unconfirmed'),
  ('failed response','cash_transaction',k,request,"'{\"completed\":false}'::jsonb",'now()','unconfirmed'),
 ]:
  run('BEGIN;'+fixture+body+f"""
   INSERT INTO entry_purchase_idempotency_receipts(key_domain,idempotency_key,request,response,completed_at)
   VALUES('{domain}','{key}',{req},{response},{completed});
   SELECT set_config('test.receipt_user','{u}',true),set_config('test.receipt_live','true',true);
   SET LOCAL ROLE authenticated;
   DO $check$ DECLARE result jsonb; BEGIN
    result := {call};
    IF result->>'status' IS DISTINCT FROM '{expected}' THEN RAISE EXCEPTION 'Receipt case failed: {label}'; END IF;
    IF '{expected}'='confirmed' AND result->'request' IS DISTINCT FROM {request}
     THEN RAISE EXCEPTION 'Receipt changed its immutable intent'; END IF;
    IF '{expected}'='unconfirmed' AND result ? 'request'
     THEN RAISE EXCEPTION 'Unconfirmed receipt leaked a request'; END IF;
    IF has_table_privilege('authenticated','public.entry_purchase_idempotency_receipts','SELECT')
     OR has_function_privilege('anon','public.fn_ca_cash_buyin_receipt(uuid,uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_ca_cash_buyin_receipt(uuid,uuid)','EXECUTE')
     THEN RAISE EXCEPTION 'Receipt lookup broadened table or anonymous access'; END IF;
   END $check$;
   RESET ROLE;
   ROLLBACK;
  """)
  cases += 1
 for user,live,code in [('', 'true','42501'),(u,'false','28000')]:
  run('BEGIN;'+fixture+body+f"""
   SELECT set_config('test.receipt_user','{user}',true),set_config('test.receipt_live','{live}',true);
   SET LOCAL ROLE authenticated;
   DO $check$ DECLARE caught boolean:=false;BEGIN
    BEGIN PERFORM {call}; EXCEPTION WHEN SQLSTATE '{code}' THEN caught:=true; END;
    IF NOT caught THEN RAISE EXCEPTION 'Missing or revoked session admitted'; END IF;
   END $check$;RESET ROLE;ROLLBACK;
  """)
  cases += 1
 print(f'cash buy-in receipt readback: {cases} PostgreSQL cases passed',flush=True)
