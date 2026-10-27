#!/usr/bin/env python3
"""Finite captured-original native qualification, never a production repair."""
import argparse,hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile
p=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--output',type=pathlib.Path,required=True);parser.add_argument('--inventory-state-read-migration',type=pathlib.Path);parser.add_argument('--wallet-jackpot-flow-migration',type=pathlib.Path);parser.add_argument('--treasury-seat-gift-migration',type=pathlib.Path);parser.add_argument('--original-occupancy-flow-migration',type=pathlib.Path);opts=parser.parse_args();o=opts.output.resolve();o.mkdir(parents=True,exist_ok=True)
pg=pathlib.Path(os.environ.get('PG_BIN',str(pathlib.Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)))
base=pathlib.Path('/Volumes/SmarterWork/agent-work') if sys.platform=='darwin' else o.parent
if sys.platform=='darwin' and not pathlib.Path('/Volumes/SmarterWork').is_mount():raise RuntimeError('mounted SSD required')
c=pathlib.Path(tempfile.mkdtemp(prefix='inventory245-',dir=base));s=c/'s';s.mkdir(mode=0o700);started=False
(o/'native-cluster-path.txt').write_text(str(c))
v=dict(os.environ,PG_BIN=str(pg),ORB_NATIVE_SOCKET=str(s),ORB_NATIVE_PORT='55931',TZ='UTC',LC_ALL='C')
if opts.inventory_state_read_migration:v['ORB_INVENTORY_STATE_READ_MIGRATION']=str(opts.inventory_state_read_migration.resolve())
if opts.wallet_jackpot_flow_migration:v['ORB_WALLET_JACKPOT_FLOW_MIGRATION']=str(opts.wallet_jackpot_flow_migration.resolve())
if opts.treasury_seat_gift_migration:v['ORB_TREASURY_SEAT_GIFT_MIGRATION']=str(opts.treasury_seat_gift_migration.resolve())
if opts.original_occupancy_flow_migration:
 if not opts.treasury_seat_gift_migration:raise RuntimeError('occupancy followup requires exact31649 baseline')
 v['ORB_ORIGINAL_OCCUPANCY_FLOW_MIGRATION']=str(opts.original_occupancy_flow_migration.resolve())
def run(name,cmd,env=None):
 r=subprocess.run([str(x) for x in cmd],text=True,capture_output=True,env=env or v,timeout=240 if name=='raw245' and (opts.wallet_jackpot_flow_migration or opts.treasury_seat_gift_migration) else 90);(o/(name+'.log')).write_text(r.stdout+r.stderr)
 if r.returncode:raise RuntimeError(name+':'+(r.stdout+r.stderr)[-2000:])
 return r
try:
 run('initdb',[pg/'initdb','-D',c/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8'])
 run('start',[pg/'pg_ctl','-D',c/'d','-l',c/'server.log','-o',f"-k {s} -p 55931 -h ''",'-w','start']);started=True
 run('platform-roles',[pg/'psql','-X','-q','-h',s,'-p','55931','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c','CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;'])
 run('source-refs',[sys.executable,p/'run-source-ref-native.py'])
 run('exact-installer',[sys.executable,p/'run-installer-native.py'])
 run('certificate-source',[sys.executable,p/'run-certificate-native.py'],dict(v,NATIVE_GENERATE_ONLY=str(s/'finite245-certificate-composition.sql')))
 run('raw-source',[sys.executable,p/'run-wrapper-native.py'],dict(v,NATIVE_GENERATE_ONLY=str(s/'finite245-raw-composition.sql')))
 run('raw245',[sys.executable,p/'run-wrapper-native.py'])
 run('cache-generation',[sys.executable,p/'run-generation-cache-native.py'])
 run('retention',[pg/'psql','-X','-q','-h',s,'-p','55931','-U','postgres','-d','original_source_refs','-v','ON_ERROR_STOP=1','-f',p/'retention-reader-native.sql'])
 run('certificate-concurrency',[sys.executable,p/'run-certificate-concurrency-native.py'])
 run('current-seven',[sys.executable,p.parent/'original-seven-discharge'/'run-native.py','--output',o/'current-seven'])
 if opts.treasury_seat_gift_migration:run('treasury-entry-gate',[sys.executable,p/'treasury-gifts/run-entry-gate-native.py'])
 migration=p.parents[2]/'supabase/migrations/20261012224150_original_retirement_evidence_certifies_finite_inventory_boun.sql'
 tested=migration.read_bytes();binding=(p/'source-binding.json').read_bytes()
 (o/'result.json').write_text(json.dumps({'status':'passed','cases':245,'source_refs':1580,'captured_original_rows':1578,'raw_active_rows':14941,'raw_issues_retained':245,'scope':'finite_original_native_not_full_week_production','migration':{'bytes':len(tested),'md5':hashlib.md5(tested).hexdigest(),'sha256':hashlib.sha256(tested).hexdigest()},'native_binding_sha256':hashlib.sha256(binding).hexdigest(),'inventory_state_read_migration':({'path':str(opts.inventory_state_read_migration),'sha256':hashlib.sha256(opts.inventory_state_read_migration.read_bytes()).hexdigest()} if opts.inventory_state_read_migration else None),'wallet_jackpot_flow_migration':({'path':str(opts.wallet_jackpot_flow_migration),'sha256':hashlib.sha256(opts.wallet_jackpot_flow_migration.read_bytes()).hexdigest()} if opts.wallet_jackpot_flow_migration else None),'treasury_seat_gift_migration':({'path':str(opts.treasury_seat_gift_migration),'sha256':hashlib.sha256(opts.treasury_seat_gift_migration.read_bytes()).hexdigest(),'bytes':len(opts.treasury_seat_gift_migration.read_bytes()),'source_authorities':65,'raw245_checks':['exact_atomic31649_ddl_rollback_replay','84_original_wallet_jackpot_credits33465_32','7_original_treasury_gifts947_returns2661_33','65_exact_source_authorities','245_original_cases_and_certificates_unchanged'],'real_frozen_78_crypto_proof':'separate exact-production rollback-only receipt required'} if opts.treasury_seat_gift_migration else None),'original_occupancy_flow_migration':({'path':str(opts.original_occupancy_flow_migration),'sha256':hashlib.sha256(opts.original_occupancy_flow_migration.read_bytes()).hexdigest(),'changed_source_authorities':3,'witness_branches':['original-event','original-application-refund'],'unchanged_original_ret_predicate':True}if opts.original_occupancy_flow_migration else None),'steps':['source-refs','exact-installer','raw245','cache-generation','retention','certificate-concurrency','current-seven']+(['treasury-entry-gate']if opts.treasury_seat_gift_migration else[])},indent=2))
 print('Finite inventory245/raw/cache/retention/currentseven qualification PASS')
finally:
 if started:run('stop',[pg/'pg_ctl','-D',c/'d','-m','immediate','-w','stop'])
 if (s/'certificate-concurrency-progress.log').exists():shutil.copyfile(s/'certificate-concurrency-progress.log',o/'certificate-concurrency-progress.log')
 if (s/'finite-generation-cache-native.log').exists():shutil.copyfile(s/'finite-generation-cache-native.log',o/'cache-generation-full.log')
 if (s/'finite245-raw-wrapper-native.log').exists():shutil.copyfile(s/'finite245-raw-wrapper-native.log',o/'raw245.log')
 if (c/'server.log').exists():shutil.copyfile(c/'server.log',o/'server.log')
 shutil.rmtree(c)
