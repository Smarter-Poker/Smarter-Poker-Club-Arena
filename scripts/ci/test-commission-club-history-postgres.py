#!/usr/bin/env python3
"""Native PG17 original R2 main/fallback club-journal regression.
Full financial stages and existing ledger/deleted-wallet core are executed.
Inventory, freeze and delivery controls are isolated prerequisites, not full
production PNL, scheduler or Messenger qualification. No production access.
"""
import argparse, hashlib, json, os, shutil, socket, subprocess, tempfile, sys, select, re
from pathlib import Path

P=argparse.ArgumentParser();P.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2]);P.add_argument('--candidate',type=Path,required=True);P.add_argument('--pg-bin',type=Path,required=True);P.add_argument('--scratch-root',type=Path,required=True);P.add_argument('--output',type=Path,required=True);P.add_argument('--fixtures',type=Path,default=Path(__file__).parent/'fixtures'/'deleted-weekly-routing');A=P.parse_args()
F=A.fixtures; BASE=A.repo/'tests/fixtures/weekly-close-scale'; EXPECTED=hashlib.sha256(A.candidate.read_bytes()).hexdigest()
matcher=(F/'actual-source40-matcher-READONLY.sql').read_text()
source40=re.findall(r"\('([^']+)','[0-9a-f]{32}'\)",matcher)
assert len(source40)==40,'actual source40 fixture membership unavailable'
assert not any(any(n in sig for n in ['fn_settle_accounting_commission_stage(', 'fn_settle_accounting_commission_stage_v3(', 'fn_accounting_legacy_pay_week(']) for sig in source40),'changed function belongs to sealed40'

if sys.platform=='darwin':
 assert str(A.scratch_root.resolve()).startswith('/Volumes/SmarterWork/agent-work/'),'external task SSD required'
 assert os.stat('/Volumes/SmarterWork').st_dev!=os.stat('/').st_dev,'external SSD mount required'
else:
 assert A.scratch_root.is_absolute(),'explicit absolute provider scratch root required'
A.scratch_root.mkdir(parents=True,exist_ok=True)
assert shutil.disk_usage(A.scratch_root).free>512*1024*1024,'512MiB native runway required'
E={k:v for k,v in os.environ.items() if not k.startswith('PG')};E.update(LC_ALL='C',LANG='C',PGTZ='UTC')
W=Path(tempfile.mkdtemp(prefix='commission-club-',dir=A.scratch_root));S=W/'s';S.mkdir();D=W/'data';started=False;results=[]
with socket.socket() as sk:sk.bind(('127.0.0.1',0));port=str(sk.getsockname()[1])
def cmd(args):return subprocess.run(list(map(str,args)),env=E,text=True,capture_output=True,check=True,timeout=60)
def q(sql,check=True):
 r=subprocess.run([str(A.pg_bin/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h','127.0.0.1','-p',port,'-d','postgres'],env=E,text=True,input=sql,capture_output=True,timeout=160)
 if check and r.returncode:raise RuntimeError(r.stderr[-8000:])
 return r

def load(p):q('SET check_function_bodies=off;\n'+p.read_text().rstrip()+';\n')
def case(name,sql,refusal=None):
 before=q('SELECT md5(dr_money()::text);').stdout.strip()
 r=q('BEGIN;\n'+sql+'\nSELECT dr_assert_bank_legs();\nROLLBACK;\n',check=False)
 if refusal:
  assert r.returncode and refusal in r.stderr,(name,r.stdout,r.stderr)
 else:assert r.returncode==0,(name,r.stdout,r.stderr)
 after=q('SELECT md5(dr_money()::text);').stdout.strip()
 assert before==after,(name,'case rollback changed financial rows',before,after)
 results.append({'case':name,'passed':True,'rollback_money_md5':after,'expected_refusal':refusal,'stdout':r.stdout.strip(),'stderr':r.stderr.strip()})

def install_attempt(name,prefix='',needle=None,suffix=''):
 # Migration BEGIN/COMMIT occurs inside disposable native cluster only.
 r=q('SET check_function_bodies=off;'+prefix+'\n'+A.candidate.read_text()+'\n'+suffix,check=False)
 if needle:assert r.returncode and needle in r.stderr,(name,r.stderr)
 else:assert r.returncode==0,(name,r.stderr)
 q('ROLLBACK; RESET ALL;')
 results.append({'case':name,'passed':True,'expected_refusal':needle,'stderr':r.stderr.strip()})

def no_install():
 q("SELECT dr_assert(to_regprocedure('smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)') IS NULL,'failed install leaked helper');")
 load(F/'assert-preimages.sql')
SEED='SELECT dr_seed();';R2="public.fn_settle_accounting_commission_stage('club',dr_u('club'),'2026-10-05 07:00+00','2026-10-12 07:00+00')";R3="public.fn_settle_accounting_rakeback_stage('club',dr_u('club'),'2026-10-05 07:00+00','2026-10-12 07:00+00')"
try:
 assert '17.' in cmd([A.pg_bin/'postgres','--version']).stdout,'PostgreSQL17 required'
 cmd([A.pg_bin/'initdb','-D',D,'-U','postgres','-A','trust','--no-locale','-E','UTF8'])
 cmd([A.pg_bin/'pg_ctl','-D',D,'-l',W/'server.log','-w','start','-o',f"-k '' -p {port} -h 127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=32MB -c work_mem=4MB -c temp_file_limit=256MB -c max_parallel_workers_per_gather=0"]);started=True
 load(BASE/'prelude.sql');load(BASE/'schema-tables.sql');load(F/'platform-boundaries.sql')
 q('SET check_function_bodies=off;')
 for n in ['fn_caller_is_engine','fn_union_week_start','fn_lock_rakeback_payer_clubs','fn_resolve_accounting_routing_scope','fn_agent_commission_rollup_recompute']:load(BASE/'preimage'/f'{n}.sql')
 for n in ['fn_guard_membership_lifecycle_write','fn_block_browser_balance_writes','fn_club_members_ledger_writer','fn_ca_declare_ledger','fn_ca_autoledger','fn_ca_chip_ledger_enrich','fn_calculate_cash_rakeback_periods','fn_rakeback_split_write','actual-R2-before','actual-R3-before','actual-deleted-credit-before','actual-bank-return-before']:load(F/(n+'.sql'))
 load(F/'ledger-enrichment-wiring.sql');load(F/'authority-and-triggers.sql');load(F/'receipt-boundary.sql');load(F/'seed.sql')

 # Existing exact deleted-routing migration installs its actual financial core.
 load(next((A.repo/'supabase/migrations').glob('20261017065530*.sql')))
 rows=json.loads((A.repo/'scripts/ci/fixtures/commission-club-history-preimages.json').read_text())
 for row in rows:
  q('SET check_function_bodies=off;'+row['definition']+';REVOKE ALL ON FUNCTION public.'+row['signature']+' FROM PUBLIC,anon,authenticated,service_role;'+('GRANT EXECUTE ON FUNCTION public.'+row['signature']+' TO service_role;' if row['signature'].startswith('fn_accounting_legacy') else ''))
 # Run both full original stages, never extracted money statements.
 # v3 lacks the later deleted-wallet deferral; active actors qualify that actual fallback.
 live="SELECT dr_seed(); SET LOCAL app.ledger_autoskip_club_members=1; UPDATE profiles SET status='active';"
 def exercise(label,call,expected_null):
  predicate='related_entity_id IS NULL' if expected_null else "related_entity_id=dr_u('club')"
  case(label,live+'SELECT '+call+"; SELECT dr_assert((SELECT count(*)=5 AND bool_and("+predicate+") AND sum(amount)=790 FROM wallet_transactions WHERE category='commission'),'all five exact credit/debit club receipts'); SELECT dr_assert((SELECT sum(amount)=510 AND count(*)=3 FROM chip_ledger WHERE category='commission'),'canonical money unchanged510'); SELECT dr_assert((SELECT chip_treasury=770 FROM clubs WHERE id=dr_u('club')),'bank230'); SELECT dr_assert((SELECT sum(chip_balance)=230 FROM club_members),'own230'); SELECT dr_assert((SELECT count(*)=3 FROM agent_commission_settlements),'three exact settlements'); SELECT dr_assert(("+call+")->>'duplicate'='true','same stage replay');")
 calls=[R2,R2.replace('commission_stage(', 'commission_stage_v3(')]
 for i,c in enumerate(calls):exercise('old-null-journal-'+str(i),c,True)
 for label,prefix,needle in [
  ('JWT',"SET request.jwt.claim.role='service_role';",'commission_club_operator_refused'),
  ('freeze','UPDATE dr_controls SET frozen=true;','commission_club_freeze_refused'),
  ('sourceguard','UPDATE dr_controls SET sealed=false;','commission_club_inventory_source_guard'),
  ('history',"INSERT INTO supabase_migrations.schema_migrations VALUES('20261020163005');",'commission_club_history_replay')]:
  install_attempt('installer-refuses-'+label,prefix,needle)
  q('UPDATE dr_controls SET frozen=false,sealed=true;DELETE FROM supabase_migrations.schema_migrations;')
  for row in rows:
   assert q("SELECT md5(pg_get_functiondef('public."+row['signature']+"'::regprocedure));").stdout.strip()==row['hash'],'refused installer changed source'
 install_attempt('exact-installer')
 for i,c in enumerate(calls):exercise('new-exactclub-journal-'+str(i),c,False)
 case('new-deleted-reserve-preserved',SEED+'SELECT '+R2+';'+(F/'assert-R2.sql').read_text())
 case('native-invoice-failure-atomic',live+"SET LOCAL dr.refuse_invoice=on;SELECT "+R2+';','routed_commission_invoice_delivery_incomplete')
 install_attempt('replay-refused',needle='commission_club_preimage_authority_changed')
 hashes=q("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'hash',md5(pg_get_functiondef(p.oid)),'acl',p.proacl::text,'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef) ORDER BY p.proname) FROM pg_proc p WHERE p.proname IN ('fn_settle_accounting_commission_stage','fn_settle_accounting_commission_stage_v3','fn_accounting_legacy_pay_week');").stdout.strip()
 report={'status':'passed','candidate_sha256':EXPECTED,'postimages':json.loads(hashes),'cases':results,'boundaries':['Actual complete R2 main/v3 and existing financial trigger core; delivery receipt shape control only','Original inventory source guard is an unrelated isolated prerequisite control','Full owner-discharge execution qualified by the connected existing parent fixture']}
 A.output.parent.mkdir(parents=True,exist_ok=True);A.output.write_text(json.dumps(report,indent=2)+'\n'); print(json.dumps(report))
finally:
 if started:subprocess.run([str(A.pg_bin/'pg_ctl'),'-D',str(D),'-m','immediate','stop'],env=E,capture_output=True)
 shutil.rmtree(W)
