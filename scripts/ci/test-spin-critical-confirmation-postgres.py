#!/usr/bin/env python3
"""Finite native PG17 proof of disjoint statistical critical confirmation."""
import argparse,ast,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
FIX=ROOT/'scripts/ci/fixtures/spin-critical-confirmation'
MIG=ROOT/'supabase/migrations/20261015215216_a_spin_distribution_critical_needs_an_independent_window.sql'
parser=argparse.ArgumentParser();parser.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));parser.add_argument('--scratch',default=os.environ.get('RUNNER_TEMP',tempfile.gettempdir()))
args=parser.parse_args();pg=Path(args.pg_bin);scratch=Path(tempfile.mkdtemp(prefix='sf-',dir=args.scratch));data=scratch/'data';started=False
def run(argv,sql=None,error=None):
 r=subprocess.run([str(v) for v in argv],input=sql,text=True,capture_output=True,timeout=120)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',scratch,'-U','postgres','-d','postgres'],sql,error)
tree=ast.parse((ROOT/'scripts/ci/test-spin-detectors.py').read_text())
def constant(name):return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets))
on_spec=constant('ON_SPEC');chance=constant('CURRENT_CHANCE');critical={**on_spec,50:40,2:on_spec[2]-31}
def seed(current,previous):
 sql=['TRUNCATE tournaments,financial_alerts;']
 for age,counts in [('1 hour',current),('8 days',previous)]:
  for multiplier,count in counts.items():sql.append("INSERT INTO tournaments(variant,status,spin_multiplier,created_at) SELECT 'spin','COMPLETED',"+str(multiplier)+",now()-interval '"+age+"'-(g*interval '1 second') FROM generate_series(1,"+str(count)+") g;")
 q('\n'.join(sql))
def verdict():
 result=json.loads(q('SELECT fn_spin_fairness_check(7);'))
 alerts=json.loads(q("SELECT coalesce(jsonb_agg(jsonb_build_array(severity,context->>'verdict')),'[]') FROM financial_alerts;"))
 return result,alerts
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(scratch)+"'\nautovacuum=off\n")
 run([pg/'pg_ctl','-D',data,'-l',scratch/'server.log','-w','start']);started=True
 q(constant('SCHEMA'))
 q("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text); CREATE TABLE fixture_freeze(frozen boolean); INSERT INTO fixture_freeze VALUES(false); CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_freeze$$; CREATE FUNCTION fn_active_maintenance_release_boundary() RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$;")
 before=(FIX/'before.sql').read_text();pins=json.loads((FIX/'pins.json').read_text());assert hashlib.md5(before.encode()).hexdigest()==pins['before']
 q(before);q('REVOKE ALL ON FUNCTION fn_spin_fairness_check(integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION fn_spin_fairness_check(integer) TO service_role;')
 seed(critical,on_spec);r,alerts=verdict();assert r['verdict']=='distribution_critical' and alerts==[['critical','distribution_critical']],'fail-before single critical';assert abs(r['z'])<4,'critical fixture isolates chi-square from expectation drift'
 catalog=q("SELECT jsonb_build_array(oid,proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid='fn_spin_fairness_check(integer)'::regprocedure;")
 migration=MIG.read_text()
 q('UPDATE fixture_freeze SET frozen=true;');q(migration,'spin_confirmation_freeze_refused');q('UPDATE fixture_freeze SET frozen=false;')
 q(migration.replace('COMMIT;',"DO $$ BEGIN RAISE EXCEPTION 'fixture_abort'; END $$; COMMIT;"),'fixture_abort')
 assert q("SELECT md5(pg_get_functiondef('fn_spin_fairness_check(integer)'::regprocedure));")==pins['before'],'atomic rollback'
 q(migration)
 seed(critical,on_spec);r,alerts=verdict();assert r['verdict']=='distribution_unconfirmed' and not alerts,'single critical stays visible without escalation';assert r['current_window_critical'] and not r['prior_window_confirms_critical']
 seed(critical,critical);r,alerts=verdict();assert r['verdict']=='distribution_critical' and alerts==[['critical','distribution_critical']] and r['prior_window_confirms_critical'],'independent critical still escalates'
 # Duplicate requests retain the existing one-open-alert-per-verdict contract.
 r,alerts=verdict();assert len(alerts)==1 and r['alerts_raised']==0,'duplicate alert protection'
 seed(critical,chance);r,alerts=verdict();assert r['verdict']=='distribution_warning' and alerts==[['warning','distribution_warning']],'independent warning remains warning'
 seed(chance,on_spec);r,alerts=verdict();assert r['verdict']=='distribution_unconfirmed' and not alerts,'warning baseline unchanged'
 seed(chance,chance);r,alerts=verdict();assert r['verdict']=='distribution_warning' and alerts==[['warning','distribution_warning']],'confirmed warning unchanged'
 seed({**on_spec,7:1},{});r,alerts=verdict();assert r['verdict']=='off_ladder' and alerts==[['critical','off_ladder']],'off-ladder remains immediate'
 seed({2:10000},{});r,alerts=verdict();assert r['verdict']=='expectation_drift' and alerts==[['critical','expectation_drift']],'expectation drift remains immediate'
 seed(critical,{});r,alerts=verdict();assert r['verdict']=='distribution_unconfirmed' and not alerts and r['prior_window_draws']==0,'no invented confirmation'
 seed(critical,critical)
 boundary=json.loads(q("BEGIN; INSERT INTO tournaments(variant,spin_multiplier,created_at) VALUES('spin',2,now()-interval '7 days'),('spin',2,now()-interval '14 days'),('spin',2,now()-interval '14 days'-interval '1 microsecond'); SELECT fn_spin_fairness_check(7); ROLLBACK;"))
 assert boundary['draws']==sum(critical.values())+1 and boundary['prior_window_draws']==sum(critical.values())+1,'disjoint exact window boundaries'
 seed({2:1999},{});r,alerts=verdict();assert r['verdict']=='insufficient_volume' and not alerts,'volume floor unchanged'
 assert catalog==q("SELECT jsonb_build_array(oid,proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid='fn_spin_fairness_check(integer)'::regprocedure;"),'authority preserved'
 assert q("SELECT md5(pg_get_functiondef('fn_spin_fairness_check(integer)'::regprocedure));")==pins['after'],'exact postimage'
 q(migration,'spin_confirmation_preimage_refused')
 print('PASS: single critical visible; disjoint critical confirmed; warnings unchanged; immediate off-ladder and expectation drift; low volume; empty prior; duplicate protection; exact boundaries; rollback; freeze; source and authority')
finally:
 if started:run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
 shutil.rmtree(scratch)
