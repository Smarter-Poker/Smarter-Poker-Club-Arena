#!/usr/bin/env python3
"""Qualify profile referral generation and uniqueness in isolated PostgreSQL 17.
The fixture models the exact generator, binding, index, grants and applicable RLS;
it does not stand in for the entire signup or financial trigger graph.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,default=ROOT/'artifacts/profile-referral-code')
args=parser.parse_args()
out=args.output.resolve()
out.mkdir(parents=True,exist_ok=False)
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL']='C'
cluster=Path(tempfile.mkdtemp(prefix='profile-referral-',dir='/tmp'))
sock=cluster/'socket'
sock.mkdir(mode=0o700)
cmd=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose',
     '-h',str(sock),'-p','55743','-U','postgres','-d','postgres']
installer=(ROOT/'supabase/migrations/20260914010500_profile_referral_code_collisions.sql').read_text()
definition=re.search(r'CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;',installer).group()
results={'scope':'exact referral generator, concurrent generation, uniqueness, authority and rollback; not full signup',
         'passed':False,'cases':[],'productionRequests':0}

def command(argv,sql=None):
    return subprocess.run(list(map(str,argv)),input=sql,text=True,capture_output=True,env=env,timeout=45)

def require(ok,message):
    if not ok: raise RuntimeError(message)

def run(name,sql,expected=None,error=None):
    r=command(cmd,sql)
    (out/(name+'.log')).write_text(r.stdout+r.stderr)
    ok=(r.returncode!=0 and error in r.stderr) if error else r.returncode==0
    if expected is not None: ok=ok and r.stdout.strip()==expected
    results['cases'].append({'name':name,'passed':ok,'expectedSqlstate':error})
    require(ok,name+': '+r.stdout[-1000:]+r.stderr[-1500:])
    return r.stdout.strip()

def probe(name,sql,expected=None,error=None):
    return run(name,'BEGIN;'+sql+';ROLLBACK;',expected,error)

def start(sql):
    process=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    process.stdin.write(sql)
    process.stdin.close()
    process.stdin=None
    return process

try:
    require(shutil.disk_usage('/tmp').free>512*1024**2,'512MiB disk reserve required')
    require(re.search(r'PostgreSQL\) 17\.',command([pg/'postgres','--version']).stdout),'PostgreSQL 17 required')
    r=command([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    require(r.returncode==0,r.stderr)
    r=command([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-o',
               f"-k {sock} -p 55743 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",'-w','start'])
    require(r.returncode==0,r.stderr)
    run('fixture',(ROOT/'scripts/ci/probes/profile-referral-code/fixture.sql').read_text())
    run('exact-predecessor',"SELECT md5(pg_get_functiondef('public.generate_referral_code()'::regprocedure))",'0abb45b7a66bbb9b944e83ace1babae9')
    run('baseline',"SELECT setseed(0.12345);INSERT INTO profiles(id) VALUES(1);SELECT setseed(0.12345);INSERT INTO profiles(id) VALUES(2);")
    run('baseline-duplicate',"SELECT count(*)::text||':'||count(DISTINCT referral_code)::text FROM profiles",'2:1')
    run('preexisting-duplicates-refused',installer,error='P0001')
    run('duplicate-refusal-preserved-evidence',"SELECT count(*)::text||':'||count(DISTINCT referral_code)::text FROM profiles",'2:1')
    run('remove-only-native-duplicate','DELETE FROM profiles WHERE id=2;')
    before=run('snapshot-before','SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p;')
    probe('candidate-canonical-md5',definition+"SELECT md5(pg_get_functiondef('public.generate_referral_code()'::regprocedure))")
    run('authority-drift-refused','BEGIN;ALTER FUNCTION public.generate_referral_code() SECURITY DEFINER;'+installer,error='P0001')
    run('binding-drift-refused','BEGIN;ALTER TABLE profiles DISABLE TRIGGER tr_generate_referral_code;'+installer,error='P0001')
    run('index-drift-refused','BEGIN;DROP INDEX idx_profiles_referral_code;CREATE INDEX idx_profiles_referral_code ON profiles(id);'+installer,error='P0001')
    run('install',installer)
    run('migration-replay',installer)
    run('migration-preserves-existing-profiles','SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p;',before)
    run('normalize-before-probe',"SELECT setseed(0.12345);INSERT INTO profiles(id) VALUES(2);")
    run('distinct-stored-codes',"SELECT count(*)::text||':'||count(DISTINCT referral_code)::text FROM profiles",'2:2')
    run('rls-owner-generation',"SET ROLE authenticated;SET test.profile_id='3';SELECT setseed(0.12345);INSERT INTO profiles(id) VALUES(3);")
    run('rls-collision-visible',"SELECT count(*)=3 AND count(DISTINCT referral_code)=3 AND bool_and(referral_code~'^SP-[0-9A-F]{6}$') FROM profiles",'t')
    probe('rls-other-user-refused',"SET LOCAL ROLE authenticated;SET LOCAL test.profile_id='3';INSERT INTO profiles(id) VALUES(4)",error='42501')
    probe('explicit-code-preserved',"SET LOCAL ROLE authenticated;SET LOCAL test.profile_id='4';INSERT INTO profiles(id,referral_code) VALUES(4,'mixed-Case') RETURNING referral_code",'mixed-Case')
    probe('explicit-duplicate-insert-refused',"INSERT INTO profiles(id,referral_code) SELECT 4,referral_code FROM profiles WHERE id=1",error='23505')
    probe('explicit-duplicate-update-refused',"UPDATE profiles SET referral_code=(SELECT referral_code FROM profiles WHERE id=1) WHERE id=2",error='23505')
    probe('exact-case-lookup-preserved',"INSERT INTO profiles(id,referral_code) SELECT 4,lower(referral_code) FROM profiles WHERE id=1 RETURNING referral_code LIKE 'sp-%'",'t')
    probe('unrelated-edit-preserved',"UPDATE profiles SET display_name='new name' WHERE id=1 RETURNING display_name='new name' AND referral_code='SP-6CA73B'",'t')
    probe('null-update-semantics-preserved',"UPDATE profiles SET referral_code=NULL WHERE id IN (1,2);SELECT count(*) FROM profiles WHERE referral_code IS NULL",'2')
    run('authority-preserved',"SELECT NOT prosecdef AND pg_get_userbyid(proowner)='postgres' AND proconfig=ARRAY['search_path=public'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.generate_referral_code()'::regprocedure",'t')
    probe('browser-direct-function-not-executable','SET LOCAL ROLE authenticated;SELECT public.generate_referral_code()',error='42501')
    probe('service-trigger-not-an-rpc','SET LOCAL ROLE service_role;SELECT public.generate_referral_code()',error='0A000')
    probe('temporary-table-cannot-hide-collision',"CREATE TEMP TABLE profiles(id integer,referral_code text);SELECT setseed(0.12345);INSERT INTO public.profiles(id) VALUES(4);SELECT count(DISTINCT referral_code)=4 FROM public.profiles",'t')
    writer=start("BEGIN;SELECT setseed(0.54321);INSERT INTO profiles(id) VALUES(100);SELECT pg_advisory_lock(913105);SELECT pg_sleep(2);COMMIT;")
    try:
        deadline=time.monotonic()+5
        while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=913105 AND granted);").stdout.strip()!='t':
            require(time.monotonic()<deadline and writer.poll() is None,'Concurrent writer did not establish barrier')
            time.sleep(0.02)
        run('concurrent-collision-skips-without-wait',"SET statement_timeout='1s';SET ROLE authenticated;SET test.profile_id='101';SELECT setseed(0.54321);INSERT INTO profiles(id) VALUES(101);")
        require(writer.poll() is None,'Second generator did not complete while first was still uncommitted')
        stdout,stderr=writer.communicate(timeout=10)
        (out/'concurrent-first-writer.log').write_text(stdout+stderr)
        require(writer.returncode==0,stderr)
    finally:
        if writer.poll() is None:
            writer.terminate()
            writer.communicate(timeout=5)
    run('concurrent-both-committed-unique',"SELECT count(*)=2 AND count(DISTINCT referral_code)=2 FROM profiles WHERE id IN (100,101)",'t')
    probe('same-transaction-multiple-candidates',"SELECT setseed(0.65432);INSERT INTO profiles(id) SELECT generate_series(200,219);SELECT count(*)=20 AND count(DISTINCT referral_code)=20 FROM profiles WHERE id BETWEEN 200 AND 219",'t')
    run('prepare-exhausted-native-sequence',"SELECT setseed(0.76543);INSERT INTO profiles(id,referral_code) SELECT g,upper('SP-'||substring(md5(random()::text),1,6)) FROM generate_series(300,427) g;")
    probe('finite-collision-budget',"SELECT setseed(0.76543);INSERT INTO profiles(id) VALUES(500)",error='54000')
    run('exhaustion-rolls-back-row',"SELECT NOT EXISTS(SELECT 1 FROM profiles WHERE id=500)",'t')
    probe('aborted-generation-releases-lock',"SELECT setseed(0.98765);INSERT INTO profiles(id) VALUES(600)")
    run('same-code-available-after-rollback',"SELECT setseed(0.98765);INSERT INTO profiles(id) VALUES(600);")
    run('unique-index-ready',"SELECT indisunique AND indisvalid AND indisready FROM pg_index WHERE indexrelid='public.idx_profiles_referral_code'::regclass",'t')
    results['passed']=True
finally:
    if (cluster/'data/postmaster.pid').exists():
        r=command([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
        require(r.returncode==0,'Could not stop owned cluster: '+r.stderr)
    if (cluster/'server.log').exists(): shutil.copyfile(cluster/'server.log',out/'server.log')
    require(not (cluster/'data/postmaster.pid').exists(),'Owned cluster still running')
    shutil.rmtree(cluster)
    results['ownedClusterRemoved']=not cluster.exists()
    (out/'RESULTS.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps({'passed':results['passed'],'cases':len(results['cases']),'evidence':str(out)}))
