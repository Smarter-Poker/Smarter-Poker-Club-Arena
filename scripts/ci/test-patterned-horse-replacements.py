#!/usr/bin/env python3
"""Real PG17 reservation concurrency + unchanged registration/roster owners.
Auth API interruption is qualified separately in HorseReplacementOnboarding.test.ts.
No network, production mutation, wallet, membership or seat creation here.
"""
import argparse, concurrent.futures, hashlib, json, os, pathlib, re, shutil, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--output',type=pathlib.Path,default=ROOT/'work/horse-replacements-native')
out=p.parse_args().output;out.mkdir(parents=True,exist_ok=True)
pg=pathlib.Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
cluster=pathlib.Path(tempfile.mkdtemp(prefix='hr62-',dir=os.environ.get('TMPDIR',str(ROOT/'work'))))
sock=cluster/'s';sock.mkdir();owner=['runuser','-u','postgres','--'] if os.geteuid()==0 else []
if owner: shutil.chown(cluster,'postgres');shutil.chown(sock,'postgres')
env=dict(os.environ,LC_ALL='C',LANG='C');checks=[]
def run(args,sql=None,fail=False):
 r=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=env,timeout=60)
 if (r.returncode!=0)!=fail: raise RuntimeError(r.stdout+r.stderr)
 return r.stdout.strip()
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55845','-U','postgres','-d','postgres']
def q(sql,fail=False): return run(psql,sql,fail)
def check(name,ok):
 checks.append({'name':name,'passed':bool(ok)})
 if not ok: raise AssertionError(name)
ids=json.loads((ROOT/'scripts/ci/fixtures/patterned-horse-retirement-cohort.json').read_text())
migrations=list((ROOT/'supabase/migrations').glob('*_retired_patterned_horses_reserve_their_replacement_identity_.sql'))
if len(migrations)!=1: raise RuntimeError('one maintained reserved migration required')
migration=migrations[0];sql=migration.read_text()
try:
 run(owner+[pg/'initdb','-D',cluster/'d','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 run(owner+[pg/'pg_ctl','-D',cluster/'d','-l',cluster/'log','-o',f"-k {sock} -p 55845 -c listen_addresses='' -c shared_buffers=16MB",'-w','start'])
 setup=(ROOT/'scripts/ci/fixtures/scheduled-horses.sql').read_text().split('INSERT INTO clubs VALUES')[0]
 q(setup)
 q('''CREATE SCHEMA smarter_private;
 CREATE TABLE smarter_private.patterned_identity_retirements(old_id uuid PRIMARY KEY,cohort text,retired_at timestamptz,replacement_horse_id uuid,tombstone text);
 CREATE TABLE ca_horse_fleet_register(horse_id uuid PRIMARY KEY,disclosed boolean,owner_entity text,funding_source text,created_at timestamptz,registered_at timestamptz DEFAULT now(),retired_at timestamptz,note text);''')
 for old in ids:
  q(f"INSERT INTO profiles(id,is_horse,status,horse_status,horse_profile) VALUES('{old}',true,'deleted','disabled','{{}}'); INSERT INTO smarter_private.patterned_identity_retirements VALUES('{old}','horse','2026-10-06 15:41Z',NULL,'tombstone-{old}'); INSERT INTO ca_horse_fleet_register(horse_id,retired_at) VALUES('{old}','2026-10-06 15:41Z');")
 q("INSERT INTO profiles(id,is_horse,status,horse_status,horse_profile) SELECT md5('original-active-'||i)::uuid,true,'active','available','{}' FROM generate_series(1,938) i; INSERT INTO ca_horse_fleet_register(horse_id) SELECT id FROM profiles WHERE status='active'; INSERT INTO ca_horse_active_roster(horse_id,rank,hands) SELECT id,row_number() OVER(ORDER BY id),0 FROM profiles WHERE status='active';")
 original=q("SELECT md5(string_agg((to_jsonb(p))::text,',' ORDER BY p.id)) FROM profiles p WHERE status='deleted'")
 before_private=q("SELECT md5(string_agg((to_jsonb(r)-'replacement_horse_id')::text,',' ORDER BY old_id)) FROM smarter_private.patterned_identity_retirements r")
 q(sql)
 live_proof=re.search(r'^-- @live-proof: (.+)$',sql,re.M).group(1)
 check('installed-reservation-body-and-private-ACL-proof',q('SELECT ('+live_proof+')')=='t')
 inspect=json.loads(q('SELECT fn_reserve_patterned_horse_replacements(false)'))
 check('inspection-is-read-only-and-returns-original-62',len(inspect['replacements'])==62 and all(x['horseId'] is None for x in inspect['replacements']))
 q('BEGIN; SELECT fn_reserve_patterned_horse_replacements(true); ROLLBACK;')
 check('rolled-back-reservation-leaves-no-identity',q('SELECT count(replacement_horse_id) FROM smarter_private.patterned_identity_retirements')=='0')
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
  replies=list(pool.map(lambda _:json.loads(q('SELECT fn_reserve_patterned_horse_replacements(true)')),range(4)))
 mapping=replies[0]['replacements']
 check('concurrent-original-reservation-has-one-stable-mapping',all(x['replacements']==mapping for x in replies))
 check('exactly62-distinct-random-v4-identities',len({x['horseId'] for x in mapping})==62 and all(re.match(r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',x['horseId']) and not x['horseId'].startswith(('00000000-','face0000-')) for x in mapping))
 check('inspection-and-resumption-preserve-every-original-id',json.loads(q('SELECT fn_reserve_patterned_horse_replacements(false)'))['replacements']==mapping)
 q(f"INSERT INTO smarter_private.patterned_identity_retirements VALUES(gen_random_uuid(),'fixture',now(),'{mapping[0]['horseId']}','extra-fixture')",True)
 check('private-unique-index-refuses-duplicate-replacement',True)
 for mutation in [f"UPDATE smarter_private.patterned_identity_retirements SET replacement_horse_id=gen_random_uuid() WHERE old_id='{ids[0]}'",f"UPDATE smarter_private.patterned_identity_retirements SET replacement_horse_id=NULL WHERE old_id='{ids[0]}'",f"DELETE FROM smarter_private.patterned_identity_retirements WHERE old_id='{ids[0]}'"]:
  q(mutation,True)
 check('original-reservation-cannot-be-replaced-cleared-or-deleted',True)
 check('initial-active-population-is-durably-recorded',replies[0]['initial_active_count']==938 and bool(replies[0]['initial_active_md5']))
 for role in ['anon','authenticated']:
  q(f'SET ROLE {role}; SELECT fn_reserve_patterned_horse_replacements(true);',True)
 check('browser-cannot-reserve-or-inspect-private-operation',q("SELECT NOT has_function_privilege('anon','fn_reserve_patterned_horse_replacements(boolean)','EXECUTE') AND NOT has_function_privilege('authenticated','fn_reserve_patterned_horse_replacements(boolean)','EXECUTE')")=='t')
 check('service-role-can-resume-same-original-operation',json.loads(q('SET ROLE service_role; SELECT fn_reserve_patterned_horse_replacements(true);'))['replacements']==mapping)
 q(f"BEGIN; UPDATE profiles SET status='active' WHERE id='{ids[0]}'; SELECT fn_reserve_patterned_horse_replacements(true); COMMIT;",True)
 check('changed-retired-original-is-refused',True)
 changed=json.loads(q("BEGIN; INSERT INTO profiles(id,is_horse,status,horse_status) VALUES(gen_random_uuid(),true,'active','available'); INSERT INTO ca_horse_fleet_register(horse_id) SELECT id FROM profiles WHERE id NOT IN(SELECT horse_id FROM ca_horse_fleet_register); SELECT fn_reserve_patterned_horse_replacements(true); ROLLBACK;"))
 check('concurrent-original-population-change-is-reported-never-masked',changed['population_changed'] is True and changed['current_original_active_count']==939 and changed['initial_active_count']==938 and changed['replacements']==mapping)
 # These profile fixture rows represent successful API onboarding. The actual
 # Auth API boundary, original metadata and once-only signup are tested in TS.
 q("INSERT INTO profiles(id,is_horse,status,horse_status,horse_profile) SELECT replacement_horse_id,true,'active','available','{\"aggression\":0.5}' FROM smarter_private.patterned_identity_retirements;")
 register=json.loads((ROOT/'scripts/ci/fixtures/patterned-horse-register-source.json').read_text())
 q(register['definition'])
 check('unchanged-installed-register-owner-source',q("SELECT md5(pg_get_functiondef('fn_ca_fleet_register_sync(uuid)'::regprocedure))")==register['md5'])
 q('SELECT fn_ca_fleet_register_sync(NULL);')
 roster_source=(ROOT/'supabase/migrations/20261023222825_scheduled_horses_play_every_game_without_roster_restrictions.sql').read_text()
 roster=re.search(r'CREATE OR REPLACE FUNCTION public.fn_ca_horse_roster_refresh\(.*?\$function\$;',roster_source,re.S).group(0)
 q(roster)
 check('unchanged-installed-full-roster-owner-source',q("SELECT md5(pg_get_functiondef('fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer)'::regprocedure))")=='e2709e7ccac97891fcbdd06ef8593a1c')
 q('SELECT fn_ca_horse_roster_refresh();')
 proof=json.loads(q('SELECT fn_reserve_patterned_horse_replacements(false)'))
 check('62-new-onboarded-identities-produce-exactly1000-active-roster',proof['eligible_active']==1000 and proof['active_roster']==1000 and proof['completed_replacements']==62)
 check('retired-original-profile-bytes-remain-unchanged',q("SELECT md5(string_agg((to_jsonb(p))::text,',' ORDER BY p.id)) FROM profiles p WHERE status='deleted'")==original)
 check('retirement-history-changes-only-reserved-replacement-column',q("SELECT md5(string_agg((to_jsonb(r)-'replacement_horse_id')::text,',' ORDER BY old_id)) FROM smarter_private.patterned_identity_retirements r")==before_private)
 check('all1062-historical-registration-rows-retained',q('SELECT count(*) FROM ca_horse_fleet_register')=='1062')
 check('no-seat-membership-or-wallet-was-provisioned',q('SELECT (SELECT count(*) FROM table_seats)+(SELECT count(*) FROM club_members)')=='0')
 q("INSERT INTO profiles(id,is_horse,status,horse_status) VALUES(gen_random_uuid(),true,'active','available'); SELECT fn_ca_fleet_register_sync(NULL); SELECT fn_ca_horse_roster_refresh();")
 drift=json.loads(q('SELECT fn_reserve_patterned_horse_replacements(false)'))
 check('later-legitimate-horse-is-preserved-and-1001-is-reported-truthfully',drift['eligible_active']==1001 and drift['active_roster']==1001 and drift['population_changed'] is True and drift['initial_active_count']==938 and drift['completed_replacements']==62)

 print(json.dumps({'passed':len(checks),'output':str(out/'RESULTS.json')}))
finally:
 if (cluster/'d/postmaster.pid').exists():run(owner+[pg/'pg_ctl','-D',cluster/'d','-m','fast','-w','stop'])
 shutil.rmtree(cluster,ignore_errors=True)
 (out/'RESULTS.json').write_text(json.dumps({'checks':checks,'production_mutations':False,'auth_api':'qualified separately with boundary mocks','cluster_removed':not cluster.exists(),'migration':str(migration.relative_to(ROOT)),'migration_sha256':hashlib.sha256(sql.encode()).hexdigest()},indent=2)+'\n')
