#!/usr/bin/env python3
"""Offline prepared; execute only after root source review. Exact full settlement cores and exact guarded migration.
Isolated controls: source40/generation, freeze/boundary and launch admission;
invoice delivery is a deliberately explicit receipt-shape stub. No live DB.
The real 90-second stage batch boundary requires one 90.1-second delay.
"""
import argparse, hashlib, json, os, shutil, socket, subprocess, tempfile, sys, select, re
from pathlib import Path

P=argparse.ArgumentParser();P.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2]);P.add_argument('--candidate',type=Path,required=True);P.add_argument('--pg-bin',type=Path,required=True);P.add_argument('--scratch-root',type=Path,required=True);P.add_argument('--output',type=Path,required=True);P.add_argument('--fixtures',type=Path,default=Path(__file__).parent/'fixtures'/'deleted-weekly-routing');A=P.parse_args()
F=A.fixtures; BASE=A.repo/'tests/fixtures/weekly-close-scale'; EXPECTED='94701e2b83ffb5ce1eae34a683f93e882d238f8609616a43f543fa6e52b8e488'
assert hashlib.sha256(A.candidate.read_bytes()).hexdigest()==EXPECTED,'candidate bytes changed: requalify exact input'
matcher=(F/'actual-source40-matcher-READONLY.sql').read_text()
source40=re.findall(r"\('([^']+)','[0-9a-f]{32}'\)",matcher)
assert len(source40)==40,'actual source40 fixture membership unavailable'
assert not any(any(n in sig for n in ['fn_settle_accounting_commission_stage(', 'fn_settle_accounting_rakeback_stage(', 'fn_ca_deleted_wallet_credit(', 'fn_ca_deleted_wallet_bank_return(']) for sig in source40),'changed function belongs to sealed40'

if sys.platform=='darwin':
 assert str(A.scratch_root.resolve()).startswith('/Volumes/SmarterWork/agent-work/'),'external task SSD required'
 assert os.stat('/Volumes/SmarterWork').st_dev!=os.stat('/').st_dev,'external SSD mount required'
else:
 assert A.scratch_root.is_absolute(),'explicit absolute provider scratch root required'
A.scratch_root.mkdir(parents=True,exist_ok=True)
assert shutil.disk_usage(A.scratch_root).free>512*1024*1024,'512MiB native runway required'
E={k:v for k,v in os.environ.items() if not k.startswith('PG')};E.update(LC_ALL='C',LANG='C',PGTZ='UTC')
W=Path(tempfile.mkdtemp(prefix='deleted-weekly-',dir=A.scratch_root));S=W/'s';S.mkdir();D=W/'data';started=False;results=[]
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
 r=q(prefix+'\n'+A.candidate.read_text()+'\n'+suffix,check=False)
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
 # Exact before regression: trigger drains first deleted parent; statement rollback.
 case('old-R2-deleted-parent-pass-through-fails',SEED+'SELECT '+R2+';','routed_commission_transfer_not_conserved')
 case('old-R3-deleted-recipient-credit-fails','SELECT dr_seed(true); ALTER TABLE club_members DISABLE TRIGGER zzzz_deleted_member_credit; SET LOCAL app.ledger_autoskip_club_members=1; UPDATE club_members SET chip_balance=90 WHERE user_id=dr_u(\'agent3\'); SET LOCAL app.ledger_autoskip_club_members=\'\'; ALTER TABLE club_members ENABLE TRIGGER zzzz_deleted_member_credit; SELECT '+R3+';','routed_rakeback_final_balance_incorrect')
 # Finite installer refusals; each has no DDL committed.
 for name,prefix,needle in [
 ('installer-browser-role','SET ROLE authenticated;','deleted_weekly_operator_refused'),
 ('installer-JWT',"SET request.jwt.claim.role='service_role';",'deleted_weekly_operator_refused'),
 ('installer-claims',"SET request.jwt.claims='{}';",'deleted_weekly_operator_refused'),
 ('installer-override',"SET ca.break_window_migration_override='on';",'deleted_weekly_freeze_or_override_refused'),
 ('installer-freeze','UPDATE dr_controls SET frozen=true;','deleted_weekly_freeze_or_override_refused'),
 ('installer-boundary',"UPDATE dr_controls SET boundary=gen_random_uuid();",'deleted_weekly_freeze_or_override_refused'),
 ('installer-history',"INSERT INTO supabase_migrations.schema_migrations VALUES('20261017065530');",'deleted_weekly_history_replay'),
 ('installer-seal','UPDATE dr_controls SET sealed=false;','deleted_weekly_inventory_seal_required')]:
  install_attempt(name,prefix,needle);no_install();q('UPDATE dr_controls SET frozen=false,boundary=NULL,sealed=true; DELETE FROM supabase_migrations.schema_migrations;')
 # Concurrent scheduler owner: established lock, no sleeps/polling correctness.
 holder=subprocess.Popen([str(A.pg_bin/'psql'),'-X','-qAt','-U','postgres','-h','127.0.0.1','-p',port,'-d','postgres'],env=E,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 holder.stdin.write("BEGIN; DO $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)); END $$; SELECT 'OWNED';\n");holder.stdin.flush()
 assert select.select([holder.stdout],[],[],10)[0],'bounded scheduler holder ACK missing'
 assert holder.stdout.readline().strip()=='OWNED','scheduler holder failed'
 install_attempt('installer-scheduler-owned',needle='deleted_weekly_scheduler_owned');no_install();holder.stdin.write('ROLLBACK;\n\\q\n');holder.stdin.flush();holder.communicate(timeout=10)
 q('ALTER TABLE club_members DISABLE TRIGGER zzzz_deleted_member_credit;')
 install_attempt('installer-credit-trigger-disabled',needle='deleted_weekly_credit_trigger_attachment_changed')
 no_install();q('ALTER TABLE club_members ENABLE TRIGGER zzzz_deleted_member_credit;')
 # A changed SECOND function must reject before any first-function alteration.
 original_r3=(F/'actual-R3-before.sql').read_text()
 q('SET check_function_bodies=off;'+original_r3.replace('BEGIN\n','BEGIN\n -- native wrong second source\n',1)+';')
 install_attempt('installer-second-source-drift',needle='deleted_weekly_preimage_authority_changed')
 load(F/'actual-R3-before.sql');q('REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;');no_install()
 # Postimage failure is injected through native DDL event, after both stages changed.
 q("CREATE FUNCTION dr_break_postimage() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN IF to_regprocedure('smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)') IS NOT NULL THEN UPDATE dr_controls SET generation='drift'; END IF; END $$; CREATE EVENT TRIGGER dr_break ON ddl_command_end EXECUTE FUNCTION dr_break_postimage();")
 install_attempt('installer-postimage-generation-atomic-rollback',needle='deleted_weekly_inventory_generation_changed');no_install();q('DROP EVENT TRIGGER dr_break; DROP FUNCTION dr_break_postimage();')
 install_attempt('installer-exact-whole-candidate')
 # Same installed file refuses replay because helper already exists.
 install_attempt('installer-source-replay',needle='deleted_weekly_reserve_already_exists')
 load(F/'assert-installed.sql')
 # Financial core and independently derived board.
 case('new-R2-three-deleted-levels-reserves90',SEED+'SELECT '+R2+';'+(F/'assert-R2.sql').read_text())
 case('new-R2-R3-live-player-and-replay',SEED+'SELECT '+R2+'; SELECT '+R3+';'+(F/'assert-R3.sql').read_text()+"SELECT dr_assert(("+R2+")->>'duplicate'='true','R2 replay'); SELECT dr_assert(("+R3+")->>'duplicate'='true','R3 replay');")
 case('stage-context-and-deferral-restored',SEED+"SET LOCAL app.deleted_wallet_routing_stage=prior_marker; SET LOCAL app.accounting_routing_context=prior_context; SELECT "+R2+'; SELECT '+R3+"; SELECT dr_assert(current_setting('app.deleted_wallet_routing_stage')='prior_marker','prior marker'); SELECT dr_assert(current_setting('app.accounting_routing_context')='prior_context','prior context'); SELECT dr_assert((SELECT bool_and(metadata->>'accounting_routing_context' <> 'prior_context') FROM chip_transactions),'claims owning stage context');")
 case('mixed-deleted-super-live-parent-deleted-sub-same-source',SEED+"UPDATE profiles SET status='active' WHERE id=dr_u('agent2'); SELECT "+R2+"; SELECT dr_assert((SELECT chip_treasury=830 FROM clubs WHERE id=dr_u('club')),'mixed treasury830'); SELECT dr_assert((SELECT chip_balance=80 FROM club_members WHERE user_id=dr_u('agent2')),'live parent own80'); SELECT dr_assert((SELECT chip_balance=0 FROM club_members WHERE user_id=dr_u('agent1')),'deleted super flushed50'); SELECT dr_assert((SELECT chip_balance=90 FROM club_members WHERE user_id=dr_u('agent3')),'deleted sub reserve90'); SELECT "+R3+"; SELECT dr_assert((SELECT sum(chip_balance)+(SELECT chip_treasury FROM clubs WHERE id=dr_u('club'))=1000 FROM club_members),'mixed total1000');")
 case('new-R3-deleted-player-bank-return','SELECT dr_seed(true); SELECT '+R2+'; SELECT '+R3+"; SELECT dr_assert((SELECT chip_treasury=1000 FROM clubs WHERE id=dr_u('club')),'all deleted return'); SELECT dr_assert((SELECT sum(chip_balance)=0 FROM club_members),'no stranded chips');")
 for n,sql in json.loads((F/'reserve-cases.json').read_text()).items():case(n,SEED+sql)
 case('invoice-refusal-rolls-back-all-money',SEED+"SET LOCAL dr.refuse_invoice=on; SELECT "+R2+';','routed_commission_invoice_delivery_incomplete')
 case('browser-forged-marker-refused',SEED+"SET LOCAL request.jwt.claim.role=authenticated; SET LOCAL app.deleted_wallet_routing_stage=commission; SELECT "+R2+';','service_role_required')
 case('browser-direct-money-forged-marker-refused',SEED+"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.role=authenticated; SET LOCAL app.deleted_wallet_routing_stage=commission; UPDATE club_members SET chip_balance=1 WHERE user_id=dr_u('agent1');",'Direct balance mutation')
 # Existing-period publisher locking is the actual observed locking contract.
 # Publish a replacement certificate while holding that existing period FOR UPDATE.
 q(SEED)
 publisher=subprocess.Popen([str(A.pg_bin/'psql'),'-X','-qAt','-U','postgres','-h','127.0.0.1','-p',port,'-d','postgres'],env=E,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 publisher.stdin.write((F/'publisher-lock.sql').read_text());publisher.stdin.flush()
 assert select.select([publisher.stdout],[],[],10)[0],'bounded publisher ACK missing'
 assert publisher.stdout.readline().strip()=='PUBLISHER_OWNS_EXISTING_PERIOD','publisher did not own existing period'
 case('existing-period-publisher-NOWAIT',"SELECT smarter_private.deleted_wallet_published_rakeback_reserve(dr_u('club'),dr_u('agent3'));",'could not obtain lock')
 publisher.stdin.write('ROLLBACK;\n\\q\n');publisher.stdin.flush();publisher.communicate(timeout=10)
 q('TRUNCATE public.accounting_cash_accrual_cutover,public.clubs,public.profiles,public.club_members,public.accounting_cash_rake_sources,public.agent_commissions,public.rakeback_periods,public.accounting_rakeback_period_calculations CASCADE;')
 # One real stage batch boundary, no replaced clock/budget/core function.
 case('R3-real-90-second-batch-reserve-then-complete','SELECT dr_seed(false,2); SELECT '+R2+"; SET LOCAL app.weekly_accounting_chunked=on; SET LOCAL app.weekly_accounting_scope_deadline='2099-01-01'; SET LOCAL dr.delay_one_r3=on; SELECT dr_assert(("+R3+")->>'batch_committed'='true','partial batch'); SELECT dr_assert((SELECT count(*)=1 FROM rakeback_periods WHERE status='pending'),'remaining one'); SELECT dr_assert(smarter_private.deleted_wallet_published_rakeback_reserve(dr_u('club'),dr_u('agent3'))=45,'remaining reserve45'); SELECT "+R3+';'+(F/'assert-R3.sql').read_text())
 report={'status':'passed','candidate_sha256':EXPECTED,'actual_source40_fixture_count':len(source40),'changed_owners_excluded_from_source40':True,'fixture_delay_case':{'case':'R3-real-90-second-batch-reserve-then-complete','delay_seconds':90.1,'production_latency_claim':False},'cases':results,'boundaries':['Native source40/generation/platform controls only; full original inventory not qualified','Receipt-shape stub only; no actual Messenger/delivery qualification','Full exact R2/R3 stages, current declared ledger/member writer/enrichment/deleted credit/bank financial core','Published existing-period publisher locking is tested, not future unpublished phantoms']}
 A.output.parent.mkdir(parents=True,exist_ok=True);A.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
finally:
 if started:subprocess.run([str(A.pg_bin/'pg_ctl'),'-D',str(D),'-m','immediate','stop'],env=E,capture_output=True)
 shutil.rmtree(W)
