#!/usr/bin/env python3
"""One original Early Bird fee cohort, through the maintained real terminal payer."""
import hashlib,json,re,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
psql,socket,port,database,out=sys.argv[1:];out=Path(out);out.mkdir(parents=True,exist_ok=True)
fix=root/'tests/fixtures/earlybird-fee-custody'
if database!='postgres' or not socket.startswith('/'):raise AssertionError('Private native fixture required')
binding=json.loads((fix/'source-binding.json').read_text())
def verify():
 for path,sha in binding['repository_files'].items():
  if hashlib.sha256((root/path).read_bytes()).hexdigest()!=sha:raise AssertionError('Early Bird source drift: '+path)
verify()
cmd=[psql,'-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',database,'-c',"SET timezone='UTC';SET statement_timeout='60s';SET lock_timeout='2s';"]
def run(sql,label):
 p=out/(label+'.sql');p.write_text(sql)
 r=subprocess.run(cmd+['-f',str(p)],capture_output=True,text=True)
 (out/(label+'.log')).write_text(r.stdout+r.stderr)
 if r.returncode:raise AssertionError(label+': '+r.stderr[-6000:])
 print('PASS '+label,flush=True)
def variable(name,path):
 raw=path.read_text().strip();json.loads(raw)
 if '$earlybird_raw$' in raw:raise AssertionError('Unsafe fixture delimiter')
 return 'SELECT $earlybird_raw$'+raw+'$earlybird_raw$ AS '+name+' \\gset\n'
run(next((root/'supabase/migrations').glob('20260918122532*.sql')).read_text(),'earlybird-current-payer-bootstrap')
run(variable('earlybird_originals',fix/'originals.json')+variable('earlybird_funding',fix/'funding-scope.json')+variable('earlybird_paid',fix/'paid-originals.json')+variable('earlybird_credits',fix/'credit-originals.json')+(fix/'setup.sql').read_text(),'earlybird-opening')
run((fix/'before.sql').read_text(),'earlybird-before-exact-refusal')
predecessors=json.loads((fix/'predecessors.json').read_text())
cohort=next(r for r in predecessors if r['identity']=='fn_ca_legacy_fee_custody_cohort(uuid)')
candidate=(root/binding['migration']).read_text()
# A dependency drift must refuse without changing any schema or ACL.
run("ALTER FUNCTION public.fn_ca_hold_legacy_tournament_fee(uuid,text) SET statement_timeout='31s';",'earlybird-dependency-drift')
dump=[str(Path(psql).with_name('pg_dump')),'--schema-only','-U','postgres','-h',socket,'-p',port,'-d',database]
def schema():return '\n'.join(s for s in subprocess.check_output(dump,text=True).splitlines() if not s.startswith(('\\restrict ','\\unrestrict ')))
before=schema();p=out/'earlybird-install-refused.sql';p.write_text(candidate)
r=subprocess.run(cmd+['-f',str(p)],capture_output=True,text=True);(out/'earlybird-install-refused.log').write_text(r.stdout+r.stderr)
if r.returncode==0 or 'Early Bird fee custody predecessor changed: fn_ca_hold' not in r.stderr or schema()!=before:raise AssertionError('Predecessor refusal must preserve full schema/ACL')
run("ALTER FUNCTION public.fn_ca_hold_legacy_tournament_fee(uuid,text) RESET statement_timeout;",'earlybird-dependency-restored')
run(candidate,'earlybird-install')
run((fix/'after.sql').read_text(),'earlybird-real-terminal-proof')
# The migration only extends the exact original tuple; payer/hold unchanged.
query="SELECT jsonb_agg(to_jsonb(x) ORDER BY identity) FROM (SELECT p.oid::regprocedure::text identity,pg_get_functiondef(p.oid) definition,md5(pg_get_functiondef(p.oid)) definition_md5,md5(p.prosrc) source_md5,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,p.proconfig config FROM pg_proc p WHERE p.oid IN("+','.join("'public."+r['identity']+"'::regprocedure" for r in predecessors)+"))x"
rows=json.loads(subprocess.check_output(cmd+['-At','-c',query],text=True))
for r in rows:
 old=next(x for x in predecessors if x['identity']==r['identity'])
 if r['identity']!=cohort['identity'] and r!=old:raise AssertionError('Payer or hold authority changed')
 if r['identity']==cohort['identity']:
  needle=' ) c(tournament_id,amount,source_fingerprint,source_count)'
  expected=cohort['definition'].replace(needle,",\n ('a5aa6984-6c1c-4b59-aeb7-9e7878853bdd'::uuid,2.70::numeric,'aab06c68bd63b23b2b7340bd55f43e44',27)\n"+needle)
  if r['definition']!=expected:raise AssertionError('Cohort must preserve all13 predecessors and append only the exact original tuple')
 if r['owner']!=old['owner'] or r['acl']!=old['acl'] or r['config']!=old['config']:raise AssertionError('Access changed')
(out/'earlybird-qualified-functions.json').write_text(json.dumps(rows,indent=2)+'\n')
verify()
count=sum(len(re.findall(r'NOTICE:\s+PASS ',p.read_text())) for p in out.glob('earlybird-*.log'))
if count!=18:raise AssertionError('Expected18 executed Early Bird assertions, observed '+str(count))
(out/'earlybird-native-evidence.json').write_text(json.dumps({'status':'passed','assertions':count,'original_fee_count':27,'fee_custody':'2.70','prize_total':'99.30','fee_source_fingerprint':'aab06c68bd63b23b2b7340bd55f43e44','before_exact_failure':True,'late_payer_rollback':True,'immutable_source_binding':binding,'limitations':'Original100 standings and recorded credit evidence; synthetic account support qualifies transactions only. Original fee/funding/escrow inputs retained; no earning terms invented and no production payment certified.'},indent=2)+'\n')
print('PASS Early Bird original27 fees: canonical player finality, retained2.70 and replay',flush=True)
