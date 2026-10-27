"""Real old outer queued at entry; same-OID leaf transition, no production."""
import argparse,hashlib,json,os,shutil,socket,subprocess,tempfile,time,textwrap,threading
from pathlib import Path
from decimal import Decimal
from concurrent.futures import ThreadPoolExecutor
Q=Path(__file__).resolve().parent;P=Q.parent
ap=argparse.ArgumentParser();ap.add_argument('--output',type=Path,required=True);a=ap.parse_args();O=a.output.resolve();O.mkdir(parents=True,exist_ok=True)
PG=Path(os.environ.get('PG_BIN',str(Path(shutil.which('psql')or'/opt/homebrew/opt/postgresql@17/bin/psql').parent)))
base=Path(tempfile.mkdtemp(prefix='queued-leaf-',dir=O));data=base/'d';started=False
with socket.socket()as sock:sock.bind(('127.0.0.1',0));port=str(sock.getsockname()[1])
env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env['TMPDIR']=str(base)
psql=[str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres']
def run(argv,sql=None,error=None):
 r=subprocess.run(list(map(str,argv)),input=sql,text=True,capture_output=True,env=env,timeout=30)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):return run(psql,sql,error)
def lit(s):return"'"+s.replace("'","''")+"'"
def load(table,rows):
 q('INSERT INTO '+table+' SELECT * FROM jsonb_populate_recordset(NULL::'+table+','+lit(json.dumps(rows))+'::jsonb)')
installers=[]
def queued(producer,install,commit):
 err=(O/('installer-new.log'if install else'installer-old.log')).open('w')
 proc=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,bufsize=1,env=env);installers.append(proc)
 proc.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(530090,1);SELECT 'gate_held';\n");proc.stdin.flush()
 while proc.stdout.readline().strip()!='gate_held':assert proc.poll()is None,'installer gate ended'
 query="BEGIN;SET LOCAL application_name='native-queued-original-outer';"+producer+";SELECT jsonb_build_object('funding',(SELECT count(*)FROM cash_participant_funding_receipts WHERE user_id="+lit(uid)+"::uuid),'gift',(SELECT count(*)FROM smarter_private.original_treasury_funding_witnesses WHERE source#>>'{ledger,metadata,user_id}'="+lit(uid)+"),'entry',(SELECT count(*)FROM entry_purchase_idempotency_receipts WHERE idempotency_key="+lit(op)+" AND response IS NOT NULL));"+('COMMIT;'if commit else'ROLLBACK;')
 with ThreadPoolExecutor(max_workers=1)as pool:
  future=pool.submit(q,query)
  end=time.monotonic()+5
  while q("SELECT EXISTS(SELECT FROM pg_locks l JOIN pg_stat_activity s ON s.pid=l.pid WHERE s.application_name='native-queued-original-outer' AND l.locktype='advisory' AND l.classid=530090 AND l.objid=1 AND NOT l.granted)")!='t':
   assert time.monotonic()<end,'old compiled outer not blocked';time.sleep(.02)
  patch=''
  if install:
   patch='INSERT INTO smarter_private.original_treasury_funding_cutover DEFAULT VALUES;'+(Q/'intermediate-qualified-outer.sql').read_text()+';'+(Q/'private-money-core.sql').read_text()+';'+(Q/'entry-claim.sql').read_text()+';'+(Q/'common-leaf.sql').read_text()+';'+(Q/'original-outer.sql').read_text()+';'
  proc.stdin.write(patch+"\nCOMMIT;SELECT 'installed';\n");proc.stdin.flush()
  while proc.stdout.readline().strip()!='installed':assert proc.poll()is None,'installer ended before commit'
  result=future.result(timeout=20)
 proc.stdin.close();proc.wait(timeout=5);err.close();assert proc.returncode==0
 return [json.loads(l)for l in result.splitlines()if l.startswith('{')]
try:
 run([PG/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 with(data/'postgresql.conf').open('a')as f:f.write("\nunix_socket_directories=''\n")
 run([PG/'pg_ctl','-D',data,'-l',base/'server.log','-o',f'-h 127.0.0.1 -p {port}','-w','start']);started=True
 q('CREATE SCHEMA smarter_private;CREATE SCHEMA extensions;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;')
 schemas=json.loads((P/'original-witness-table-columns.json').read_text());schemas.update(json.loads((P/'addon-authorities.json').read_text())['columns']);schemas.update(json.loads((P/'78-financial-only.json').read_text())['columns'])
 for name,cols in schemas.items():q('CREATE TABLE public.'+name+'('+','.join('"'+c['name']+'" '+c['type']for c in cols)+')')
 q((P/'treasury-lineage-original.sql').read_text());witness_setup=(P/'original-treasury-witnesses.sql').read_text();assert witness_setup.count('INSERT INTO smarter_private.original_treasury_funding_cutover DEFAULT VALUES;')==1;q(witness_setup.replace('INSERT INTO smarter_private.original_treasury_funding_cutover DEFAULT VALUES;',''));q((P/'fn_pnl_evidence_cents.sql').read_text());q((P/'fn_cash_record_original_funding.sql').read_text())
 q('ALTER TABLE cash_participant_funding_receipts ALTER COLUMN id SET DEFAULT gen_random_uuid(),ALTER COLUMN unit_scale SET DEFAULT2,ALTER COLUMN transaction_id SET DEFAULT pg_current_xact_id()'.replace('DEFAULT2','DEFAULT 2'))
 # Actual original money, claim, completion and new proof owners; unrelated
 # authorization/session/event-capture surfaces are explicit native boundaries.
 source=(P/'native-original-hands.py').read_text();start=source.index(' q("""CREATE SCHEMA auth;');end=source.index(" for owner in json.loads((P/'entry-receipt-owners.json')",start)
 exec(textwrap.dedent(source[start:end]),globals(),globals())
 for owner in json.loads((P/'entry-receipt-owners.json').read_text()):q(owner['definition'])
 q((P/'fn_release_entry_purchase_claim.sql').read_text());q((P/'original-horse-seat-money-core.sql').read_text());q((Q/'original-outer.sql').read_text())
 old_money_source=q("SELECT md5(prosrc)FROM pg_proc WHERE oid='public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)'::regprocedure")
 old_outer_md5=q("SELECT md5(pg_get_functiondef('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)'::regprocedure))")
 q('REVOKE ALL ON FUNCTION public.fn_claim_entry_purchase_receipt(text,text,jsonb)FROM PUBLIC,anon,authenticated,service_role')
 q('REVOKE ALL ON FUNCTION public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)FROM PUBLIC,anon,authenticated,service_role')
 tid='11111111-0000-0000-0000-000000000001';uid='22222222-0000-0000-0000-000000000001';op='33333333-0000-0000-0000-000000000001';bank='fade0000-0000-0000-0000-000000000001';benefit='a0000000-0000-0000-0000-000000000001'
 load('clubs',[{'id':bank,'asset':'chips','union_id':bank,'chip_treasury':10000},{'id':benefit,'asset':'chips','union_id':bank,'chip_treasury':0}]);load('tables',[{'id':tid,'club_id':bank,'union_id':bank,'min_buy_in':100,'max_buy_in':1000}]);load('native_beneficiaries',[{'user_id':uid,'club_id':benefit}])
 producer='SELECT fn_horse_seat_from_treasury('+lit(tid)+'::uuid,'+lit(uid)+'::uuid,1,200,'+lit(op)+'::uuid)'
 old=queued(producer,False,False);assert old[0]['success']and old[1]=={'funding':0,'gift':0,'entry':1},old
 assert Decimal(q('SELECT chip_treasury FROM clubs WHERE id='+lit(bank)+'::uuid'))==10000
 new=queued(producer,True,True);assert new[0]['success']and new[1]=={'funding':1,'gift':1,'entry':1},new
 assert json.loads(q(producer))==new[0]
 assert old_money_source==q("SELECT md5(prosrc)FROM pg_proc WHERE oid='smarter_private.original_treasury_seat_money_core(uuid,uuid,integer,numeric,uuid)'::regprocedure")
 assert q("SELECT bool_and((w.source#>>'{entry,claimed_at}')::timestamptz<c.installed_at AND(w.source#>>'{flow,recognized_at}')::timestamptz>c.installed_at AND NOT w.historical_late)FROM smarter_private.original_treasury_funding_witnesses w CROSS JOIN smarter_private.original_treasury_funding_cutover c")=='t'
 assert q('SELECT count(*)FROM smarter_private.original_treasury_historical_admissions')=='0'
 assert Decimal(q('SELECT chip_treasury FROM clubs WHERE id='+lit(bank)+'::uuid'))==9800
 assert q("SELECT count(*)FROM chip_ledger WHERE idempotency_key='horse_fund:"+op+"'")=='1'
 assert q("SELECT bool_and(smarter_private.cash_initial_funding_receipt(id))FROM cash_participant_funding_receipts")=='t'
 assert q("SELECT md5(pg_get_functiondef('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)'::regprocedure))")==old_outer_md5
 cases=['entry_started_before_cutover_but_original_recognition_after_commit_is_future_with_receipt_no_backdate','old_original_outer_queued_at_shared_gate_reproduces_missing_receipt_rolled_back','same_old_compiled_outer_resumes_after_installer_commit_with_one_exact_new_leaf_receipt','exact_key_replay_one_debit_one_gift_one_funding','original_outer_body_unchanged']
 # Old NULL-key outer completes with an internally keyed, proven leaf admission.
 uid2='22222222-0000-0000-0000-000000000002';load('native_beneficiaries',[{'user_id':uid2,'club_id':benefit}]);nullproducer=producer.replace(lit(uid),lit(uid2)).replace('::uuid,1,200,','::uuid,2,200,').replace(lit(op)+'::uuid','NULL::uuid');assert json.loads(q(nullproducer))['success']
 assert q('SELECT count(*)FROM cash_participant_funding_receipts WHERE user_id='+lit(uid2)+'::uuid')=='1';cases.append('old_null_key_outer_gets_internal_original_key_and_complete_funding')
 null_before=q('SELECT chip_treasury FROM clubs WHERE id='+lit(bank)+'::uuid');assert json.loads(q(nullproducer))['success']is False;assert q('SELECT chip_treasury FROM clubs WHERE id='+lit(bank)+'::uuid')==null_before;assert q('SELECT count(*)FROM cash_participant_funding_receipts WHERE user_id='+lit(uid2)+'::uuid')=='1';cases.append('old_null_key_repeat_seat_refusal_creates_no_second_debit_or_receipt')
 # A failing new proof rolls back the whole old-outer entry, including claim.
 uid3='22222222-0000-0000-0000-000000000003';op3='33333333-0000-0000-0000-000000000003';load('native_beneficiaries',[{'user_id':uid3,'club_id':benefit}]);failproducer=producer.replace(lit(uid),lit(uid3)).replace(lit(op),lit(op3)).replace('::uuid,1,200,','::uuid,3,200,')
 q("BEGIN;SET LOCAL native.asset='diamonds';"+failproducer+';ROLLBACK;','original_treasury_gift_proof_refused')
 assert q('SELECT count(*)FROM entry_purchase_idempotency_receipts WHERE idempotency_key='+lit(op3))=='0'
 assert q('SELECT count(*)FROM table_seats WHERE user_id='+lit(uid3)+'::uuid')=='0'
 assert json.loads(q(failproducer))['success'];cases.append('old_outer_proof_failure_atomically_rolls_back_claim_bank_seat_ledger_then_samekey_retry_once')
 # Existing incomplete committed claims retain the original refusal.
 badop='33333333-0000-0000-0000-000000000004';bad=producer.replace(lit(op),lit(badop));request={'door':'fn_horse_seat_from_treasury','table_id':tid,'user_id':uid,'seat_number':1,'amount':200}
 load('entry_purchase_idempotency_receipts',[{'key_domain':'horse_funding','idempotency_key':badop,'request':request}]);q(bad,'INCOMPLETE_IDEMPOTENCY_RECEIPT');cases.append('committed_incomplete_claim_still_refused_not_reclaimed')
 # A real caller subtransaction rolls back its claim marker with its money.
 uid4='22222222-0000-0000-0000-000000000004';op4='33333333-0000-0000-0000-000000000014';load('native_beneficiaries',[{'user_id':uid4,'club_id':benefit}]);nested=producer.replace(lit(uid),lit(uid4)).replace(lit(op),lit(op4)).replace('::uuid,1,200,','::uuid,4,200,')
 before_bank=q('SELECT chip_treasury FROM clubs WHERE id='+lit(bank)+'::uuid')
 q("DO $sub$BEGIN BEGIN PERFORM "+nested.removeprefix('SELECT ')+";RAISE EXCEPTION USING ERRCODE='ZX004',MESSAGE='native rollback';EXCEPTION WHEN SQLSTATE 'ZX004' THEN NULL;END;END$sub$")
 assert q('SELECT chip_treasury FROM clubs WHERE id='+lit(bank)+'::uuid')==before_bank
 assert q('SELECT count(*)FROM entry_purchase_idempotency_receipts WHERE idempotency_key='+lit(op4))=='0'
 assert json.loads(q(nested))['success'];cases.append('actual_caller_subtransaction_claim_and_money_rollback_then_samekey_retry')
 normal=q("BEGIN;SELECT fn_claim_entry_purchase_receipt('ordinary_other_domain','native-other-domain','{}'::jsonb);SELECT NULLIF(current_setting('app.original_treasury_entry_claim',true),'')IS NULL;ROLLBACK;").splitlines();assert json.loads(normal[0])=={'claimed':True}and normal[-1]=='t';cases.append('other_entry_domains_original_claim_behavior_unchanged')
 assert q("SELECT bool_and(NOT has_function_privilege(r,'smarter_private.original_treasury_seat_money_core(uuid,uuid,integer,numeric,uuid)','EXECUTE'))FROM unnest(ARRAY['service_role','anon','authenticated'])r")=='t'
 assert q("SELECT bool_and(NOT has_function_privilege(r,'public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)','EXECUTE'))FROM unnest(ARRAY['service_role','anon','authenticated'])r")=='t';cases.append('public_common_leaf_and_private_money_core_remain_postgres_only')
 sigs=['public.fn_claim_entry_purchase_receipt(text,text,jsonb)','public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)','smarter_private.original_treasury_seat_money_core(uuid,uuid,integer,numeric,uuid)','public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)']
 posts=json.loads(q("SELECT jsonb_agg(jsonb_build_object('signature',s.signature,'body',pg_get_functiondef(p.oid),'md5',md5(pg_get_functiondef(p.oid)),'owner',p.proowner::regrole::text,'acl',p.proacl::text,'config',p.proconfig)ORDER BY signature)FROM(VALUES"+','.join('('+lit(x)+')'for x in sigs)+')s(signature)JOIN pg_proc p ON p.oid=to_regprocedure(s.signature)'))
 delivery_check_signatures=sigs
 exec(compile((P/'assert-delivery-owned.py').read_text(),str(P/'assert-delivery-owned.py'),'exec'),globals(),globals())
 (O/'postimages.json').write_text(json.dumps(posts,indent=2)+'\n');(O/'result.json').write_text(json.dumps({'status':'passed','cases':cases,'original_money_core_changed':False,'new_private_money_core_acl':'postgres-only','old_queued_outer_body_unchanged':True,'limits':'Actual old outer/money core/claim/completion and new proof/leaf run in isolatedPG17; authorization, sessions and original capture triggers controlled native boundaries.'},indent=2)+'\n');print((O/'result.json').read_text())
finally:
 for p in installers:
  if p.poll()is None:p.terminate();p.wait(timeout=5)
 if started:run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(base,ignore_errors=True)
