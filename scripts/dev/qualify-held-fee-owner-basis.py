#!/usr/bin/env python3
"""Owner-authorized held tournament fee basis, through the maintained native runner.

Runs after the maintained Early Bird phase has produced its honest held fee.
The owner path is first brought to the exact bodies production had installed
when the candidate was written (captured pg_get_functiondef, md5-checked).
Synthetic agreements then exist at completion only; the installed predecessor
still refuses, the candidate migration installs, and the single owner
operation resolves the exact fee through the canonical settlement and
recognition owners.
"""
import hashlib,json,re,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
psql,socket,port,database,out=sys.argv[1:6];out=Path(out);out.mkdir(parents=True,exist_ok=True)
spin_retention=sys.argv[6:]==['--spin-retention']
if sys.argv[6:] and not spin_retention:raise AssertionError('Unknown native phase selection')
fix=root/'tests/fixtures/held-fee-owner-basis'
binding=json.loads((fix/'source-binding.json').read_text())
def verify():
 for path,sha in binding['repository_files'].items():
  if hashlib.sha256((root/path).read_bytes()).hexdigest()!=sha:raise AssertionError('Held fee owner basis source drift: '+path)
verify()
if database!='postgres' or not socket.startswith('/'):raise AssertionError('Private native fixture required')
cmd=[psql,'-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',database,'-c',"SET timezone='UTC';SET statement_timeout='60s';SET lock_timeout='2s';"]
def run(sql,label):
 p=out/(label+'.sql');p.write_text(sql)
 r=subprocess.run(cmd+['-f',str(p)],capture_output=True,text=True)
 (out/(label+'.log')).write_text(r.stdout+r.stderr)
 if r.returncode:raise AssertionError(label+': '+r.stderr[-6000:])
 print('PASS '+label,flush=True)
def md5_of(identity):
 return subprocess.check_output(cmd+['-At','-c',"SELECT COALESCE((SELECT md5(pg_get_functiondef(to_regprocedure('"+identity+"')))),'absent')"],text=True).strip()
# 1. Production parity for every function on the owner path.
captured=json.loads((fix/'production-owner-path.json').read_text())
sql='BEGIN;\n'
for row in captured:
 if hashlib.md5(row['definition'].encode()).hexdigest()!=row['md5']:raise AssertionError('Captured definition corrupt: '+row['identity'])
 if row['owner']!='postgres':raise AssertionError('Unexpected captured owner: '+row['identity'])
 sql+=row['definition']+';\n'
 if row['identity']=='public.fn_accounting_union_earned_plan_v3(uuid,timestamptz,timestamptz)':
  sql+='REVOKE ALL ON FUNCTION '+row['identity']+' FROM PUBLIC,anon,authenticated,service_role;\n'
sql+='COMMIT;\n'
run(sql,'held-fee-production-owner-path')
parity={row['identity']:md5_of(row['identity']) for row in captured}
drift=[k for k,v in parity.items() if v!=next(r['md5'] for r in captured if r['identity']==k)]
(out/'held-fee-production-parity.json').write_text(json.dumps(parity,indent=2)+'\n')
if drift:raise AssertionError('Owner path not at production parity: '+', '.join(drift))
print('PASS owner path carries the '+str(len(captured))+' captured production bodies',flush=True)
candidate=(root/binding['migration']).read_text()
if spin_retention:
 # After the maintained September 8 Spin phase: the five retained standings
 # witnesses against the owner's eight-day horse hand-history retention.
 run("""BEGIN;
CREATE TABLE IF NOT EXISTS public.hand_history_retention_policy(id boolean PRIMARY KEY DEFAULT true CHECK(id),
 horse_retention_days integer NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),note text);
INSERT INTO public.hand_history_retention_policy(id,horse_retention_days,note)
 VALUES(true,8,'Owner instruction September 17, 2026: retain horse hand history for eight days; immutable accounting receipts are retained independently.')
 ON CONFLICT(id) DO NOTHING;
COMMIT;
""",'held-fee-spin-retention-policy')
 retention=(fix/'spin-retention.sql').read_text()
 run('\\set phase before\n'+retention,'held-fee-spin-before')
 run(candidate,'held-fee-spin-install')
 run('\\set phase after\n'+retention,'held-fee-spin-after')
 verify()
 count=sum(len(re.findall(r'NOTICE:\s+PASS ',p.read_text())) for p in out.glob('held-fee-spin-*.log'))
 if count!=binding['spin_assertions']:raise AssertionError('Expected '+str(binding['spin_assertions'])+' executed spin retention assertions, observed '+str(count))
 (out/'held-fee-spin-native-evidence.json').write_text(json.dumps({'status':'passed','assertions':count,'events':5,
  'limitations':'Original retained Spin standings; hand deletions are rolled back subtransactions modelling the owner retention.'},indent=2)+'\n')
 print('PASS five Sept-8 Spin receipts survive the owner horse retention; changed or half-retired hands still refuse',flush=True)
 sys.exit(0)
run((fix/'setup.sql').read_text(),'held-fee-scene')
run((fix/'terms.sql').read_text(),'held-fee-completion-terms')
run((fix/'before.sql').read_text(),'held-fee-before-exact-refusal')
# 2. A changed predecessor refuses the whole migration with schema and ACL intact.
dump=[str(Path(psql).with_name('pg_dump')),'--schema-only','-U','postgres','-h',socket,'-p',port,'-d',database]
def schema():return '\n'.join(s for s in subprocess.check_output(dump,text=True).splitlines() if not s.startswith(('\\restrict ','\\unrestrict ')))
run("ALTER FUNCTION public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz) SET statement_timeout='31s';",'held-fee-dependency-drift')
before=schema();p=out/'held-fee-install-refused.sql';p.write_text(candidate)
r=subprocess.run(cmd+['-f',str(p)],capture_output=True,text=True);(out/'held-fee-install-refused.log').write_text(r.stdout+r.stderr)
if r.returncode==0 or 'held tournament fee owner basis predecessor changed: public.fn_accounting_union_earned_plan' not in r.stderr or schema()!=before:
 raise AssertionError('Predecessor refusal must preserve full schema/ACL: '+r.stderr[-2000:])
print('PASS held-fee-install-refused',flush=True)
run("ALTER FUNCTION public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz) RESET statement_timeout;",'held-fee-dependency-restored')
# 3. Install, then the owner operation and its refusals, replays and weekly readers.
run(candidate,'held-fee-install')
import runpy
member_lane=runpy.run_path(str(fix/'qualify-member-lane.py'))['qualify'](root,fix,out,cmd,run,schema)
run((fix/'after.sql').read_text(),'held-fee-owner-operation')
query="SELECT jsonb_agg(to_jsonb(x) ORDER BY identity) FROM (SELECT p.oid::regprocedure::text identity,md5(pg_get_functiondef(p.oid)) definition_md5,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,p.proconfig config FROM pg_proc p WHERE p.oid IN('public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'::regprocedure,'public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_accounting_union_earned_plan_v3(uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure,'public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb)'::regprocedure,'smarter_private.spin_original_standings_witness(uuid,uuid)'::regprocedure,'public.fn_accounting_tournament_source_terms_at(uuid,timestamptz,jsonb)'::regprocedure,'public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb)'::regprocedure))x"
rows=json.loads(subprocess.check_output(cmd+['-At','-c',query],text=True))
modified={'public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)','public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)','public.fn_accounting_union_earned_plan_v3(uuid,timestamptz,timestamptz)','public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])','public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb)','smarter_private.spin_original_standings_witness(uuid,uuid)'}
for c in captured:
 if c['identity'] not in modified:
  expected=next((r['md5'] for r in json.loads((fix/'member-lane-production.json').read_text()) if r['identity']==c['identity']),c['md5'])
  if md5_of(c['identity'])!=expected:raise AssertionError('Candidate changed an unlisted owner-path body: '+c['identity'])
  continue
 got=subprocess.check_output(cmd+['-At','-c',"SELECT COALESCE(p.proacl::text,'')||'|'||pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid=to_regprocedure('"+c['identity']+"')"],text=True).strip()
 if got!=(c['acl'] or '')+'|'+c['owner']:raise AssertionError('Access changed: '+c['identity'])
 if md5_of(c['identity'])==c['md5']:raise AssertionError('Candidate did not extend '+c['identity'])
(out/'held-fee-qualified-functions.json').write_text(json.dumps(rows,indent=2)+'\n')
verify()
count=sum(len(re.findall(r'NOTICE:\s+PASS ',p.read_text())) for p in out.glob('held-fee-*.log'))
expected=binding['assertions']
if count!=expected:raise AssertionError('Expected '+str(expected)+' executed held-fee assertions, observed '+str(count))
(out/'held-fee-native-evidence.json').write_text(json.dumps({'status':'passed','assertions':count,'event':'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd','fee':'2.70','original_fee_rows':27,
 'production_parity_functions':len(captured),'member_lane':member_lane,'before_exact_refusal':True,'predecessor_drift_refusal':True,'immutable_source_binding':binding,
 'limitations':'Agreements at completion and account shells are synthetic; the original fee, funding and escrow rows are retained. This qualifies the transaction, not a production payment.'},indent=2)+'\n')
print('PASS owner-authorized basis resolves the held original fee once, conserved and weekly-verifiable',flush=True)
