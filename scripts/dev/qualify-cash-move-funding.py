#!/usr/bin/env python3
"""Original cash move accounting regression in the maintained native cluster."""
import hashlib,json,os,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
psql,socket,port,work=sys.argv[1:];work=Path(work)
fix=root/'tests/fixtures/cash-participant-funding'
database='cash_move_'+str(os.getpid())
subprocess.run([psql,'-X','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d','postgres','-c','CREATE DATABASE '+database+' TEMPLATE postgres'],check=True,capture_output=True)
inputs=['scripts/dev/qualify-cash-move-funding.py','tests/fixtures/cash-participant-funding/captured-move-preimages.json','tests/fixtures/cash-participant-funding/move-authority.sql','tests/fixtures/cash-participant-funding/build-move-candidate.py','tests/fixtures/cash-participant-funding/move-before.sql','tests/fixtures/cash-participant-funding/move-after.sql','tests/fixtures/cash-participant-funding/move-boundary.sql',str(next((root/'supabase/migrations').glob('20260918032932*.sql')).relative_to(root))]
(work/'cash-move-tested-binding.json').write_text(json.dumps({p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in inputs},indent=2)+'\n')
def run(sql,label):
 path=work/(label+'.sql');path.write_text(sql)
 r=subprocess.run([psql,'-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',database,'-f',str(path)],capture_output=True,text=True)
 (work/(label+'.log')).write_text(r.stdout+r.stderr)
 if r.returncode:raise AssertionError(label+': '+r.stderr[-6500:])
 print('PASS '+label,flush=True)
def capture(query,label):
 r=subprocess.check_output([psql,'-X','-At','-U','postgres','-h',socket,'-p',port,'-d',database,'-c',query],text=True)
 (work/(label+'.json')).write_text(json.dumps(json.loads(r),indent=2)+'\n')
# Exact original move table and binding trigger; no modeled transfer owner.
s=(root/'supabase/migrations/20260909074353_bind_cash_seat_moves_to_original_occupancies.sql').read_text()
ddl='ALTER TABLE cash_seat_moves ADD COLUMN IF NOT EXISTS source_occupancy_id uuid; ALTER TABLE cash_seat_moves ADD COLUMN IF NOT EXISTS source_seat_number integer;\n'
ddl+=s[s.index('CREATE TABLE IF NOT EXISTS public.cash_seat_move_receipts'):s.index('CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute')]
run(ddl,'cash-move-original-schema')
rows=json.loads((fix/'captured-move-preimages.json').read_text());sql='SET check_function_bodies=off;\n'
for r in rows:
 sql+=r['definition']+';\nREVOKE ALL ON FUNCTION public.'+r['signature']+' FROM PUBLIC,anon,authenticated,service_role;\n'
 for role in ['authenticated','service_role']:
  if role+'=' in r['acl']:sql+='GRANT EXECUTE ON FUNCTION public.'+r['signature']+' TO '+role+';\n'
 sql+='ALTER FUNCTION public.'+r['signature']+' OWNER TO '+r['owner']+';\n'
# Original retained atomic proof comparator is a reader prerequisite only.
s=next((root/'supabase/migrations').glob('20260918004443*.sql')).read_text()
s=s[s.index('CREATE FUNCTION public.fn_cash_atomic_original_matches'):s.index('DO $reader$;') if 'DO $reader$;' in s else s.index('DO $reader$')]
sql+=s.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
run(sql,'cash-move-original-owners')
run((fix/'move-before.sql').read_text(),'cash-move-before')
run(next((root/'supabase/migrations').glob('20260918032932*.sql')).read_text(),'cash-move-successor')
names="'fn_cash_original_funding_lineage','fn_cash_capture_hand_manifest','fn_pnl_cash_hand_evidence','fn_union_pnl_boundary'"
capture("SELECT jsonb_agg(to_jsonb(x) ORDER BY signature) FROM (SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,md5(pg_get_functiondef(p.oid)) definition_md5,md5(p.prosrc) body_md5,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,p.prosecdef security_definer,p.proconfig configuration FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ("+names+")) x",'cash-move-candidate-functions')
capture("SELECT jsonb_build_object('columns',(SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.cash_seat_move_receipts'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) x),'triggers',(SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT tgname,tgenabled,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE tgrelid='public.cash_seat_move_receipts'::regclass AND NOT tgisinternal ORDER BY tgname) x),'relation',(SELECT jsonb_build_object('owner',pg_get_userbyid(relowner),'acl',relacl::text,'rls',relrowsecurity) FROM pg_class WHERE oid='public.cash_seat_move_receipts'::regclass))",'cash-move-candidate-relation')
# A real transaction starts its book frame before the original hand, but
# records its debit after that hand has been accepted in another connection.
with (work/'cash-move-late-funding.log').open('w') as error_log:
 late=subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',database],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=error_log,text=True)
 try:
  late.stdin.write("BEGIN; SET request.jwt.claims='{\"role\":\"service_role\",\"sub\":\"00000000-0000-0000-0000-000000000901\"}'; SELECT fn_union_pnl_original_frame(); SELECT 'FRAME_READY';\n");late.stdin.flush()
  while True:
   line=late.stdout.readline()
   if not line:raise AssertionError('Late funding frame did not become ready')
   if line.strip()=='FRAME_READY':break
  run((fix/'move-after.sql').read_text(),'cash-move-after')
  out,_=late.communicate("SELECT fixture.assert(fn_horse_fund_from_treasury_before_maintenance_gate(fixture.u(1203),fixture.u(1191),7,fixture.u(1499))->>'success'='true','Actual funding records after the captured hand'); COMMIT;\n",timeout=15)
  if late.returncode:raise AssertionError('Late original funding transaction failed: '+out)
 finally:
  if late.poll() is None:late.kill();late.wait()
run("""
SELECT fixture.assert((SELECT f.recorded_at>(p->'funding_lineage'->>'observed_at')::timestamptz AND b.observed_at<(p->'funding_lineage'->>'observed_at')::timestamptz FROM cash_participant_funding_receipts f JOIN union_pnl_transaction_frames b USING(transaction_id) CROSS JOIN cash_hand_participant_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.participants) p WHERE f.operation_key=fixture.u(1499)::text AND m.hand_number=1013003 AND p->>'user_id'=fixture.u(1191)::text),'Concurrent receipt really records later inside an earlier original frame');
SELECT fixture.assert(fn_pnl_cash_hand_evidence(fixture.u(1203),1013003)->>'status'='ready','A later debit in an earlier transaction frame cannot change an already accepted hand');
SET timezone='Asia/Tokyo';
SELECT fixture.assert((SELECT bool_and(fn_cash_original_funding_lineage((p->>'user_id')::uuid,m.table_id,(p->>'seat_id')::uuid,(p->>'occupancy_id')::uuid,(p->>'seat_joined_at')::timestamptz,(p#>>'{funding_lineage,observed_at}')::timestamptz,false)=p->'funding_lineage') FROM cash_hand_participant_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.participants) p WHERE m.hand_number=1013003),'Frozen lineage serialization is independent of the reader session timezone');
""",'cash-move-late-funding-proof')


run((fix/'move-boundary.sql').read_text(),'cash-move-boundary')
