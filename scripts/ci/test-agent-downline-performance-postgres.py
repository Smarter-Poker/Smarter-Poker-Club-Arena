import json,os,subprocess,tempfile,shutil,time
from pathlib import Path
root=Path(__file__).resolve().parents[2];pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'));w=Path(tempfile.mkdtemp(prefix='downline-benchmark-',dir=os.environ.get('RUNNER_TEMP','/Volumes/SmarterWork/agent-work/bank-downline-20261020/tmp')));sock=w/'s';sock.mkdir();data=w/'data'

def run(args,sql=None):
 p=subprocess.run([str(a) for a in args],input=sql,text=True,capture_output=True,timeout=90);assert p.returncode==0,(p.stdout,p.stderr);return p.stdout.strip()
def q(sql):return run([pg/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',sock,'-U','fixture_admin','postgres'],sql)
club='00000000-0000-4000-8000-000000000100'
migration=next((root/'supabase/migrations').glob('*_agent_transfer_review_history_and_scope_events.sql')).read_text()
start=migration.index('CREATE OR REPLACE FUNCTION public.fn_club_is_in_downline(')
new=migration[start:migration.index('$$;',start)+3]

try:
 run([pg/'initdb','-D',data,'-U','fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8']);run([pg/'pg_ctl','-D',data,'-o',"-h '' -k '"+str(sock)+"'",'-l',w/'pg.log','-w','start'])
 q('CREATE TABLE profiles(id uuid PRIMARY KEY,status text); CREATE TABLE club_members(club_id uuid,user_id uuid,agent_id uuid,role text,status text,PRIMARY KEY(club_id,user_id)); CREATE TABLE agents(club_id uuid,user_id uuid,status text,PRIMARY KEY(club_id,user_id)); CREATE INDEX ON club_members(club_id,agent_id,user_id);')
 defs=json.loads((root/'scripts/ci/fixtures/agent-data-boundary/enhancement-preimages.json').read_text())
 for name in ['fn_cashier_member_is_active','fn_club_active_cashier_edges','fn_club_is_in_downline']:q(next(d['definition'] for d in defs if d['proname']==name))
 q(f"INSERT INTO club_members SELECT '{club}',md5(i::text)::uuid,CASE WHEN i=1 THEN NULL WHEN i<=21 THEN md5('1')::uuid ELSE md5((2+i%20)::text)::uuid END,CASE WHEN i<=21 THEN 'agent' ELSE 'player' END,'active' FROM generate_series(1,5021) i; INSERT INTO agents SELECT club_id,user_id,'active' FROM club_members WHERE role='agent'; ANALYZE;")
 sql=f"SELECT count(*) FROM generate_series(22,121) n WHERE fn_club_is_in_downline('{club}',md5('2')::uuid,md5(n::text)::uuid);"
 matrix=f"SELECT array_agg(fn_club_is_in_downline('{club}',md5(u::text)::uuid,md5(m::text)::uuid) ORDER BY u,m) FROM unnest(ARRAY[1,2,3,21]) u CROSS JOIN unnest(ARRAY[1,2,3,22,23,45,5000]) m;"
 # Depth, cycles, missing/inactive links, null and self must preserve the original contract.
 q(f"INSERT INTO club_members SELECT '{club}',md5(('deep'||i)::text)::uuid,CASE WHEN i=0 THEN NULL ELSE md5(('deep'||(i-1))::text)::uuid END,'agent','active' FROM generate_series(0,22) i; INSERT INTO agents SELECT club_id,user_id,'active' FROM club_members WHERE user_id IN(SELECT md5(('deep'||i)::text)::uuid FROM generate_series(0,22) i);")
 boundaries=f"SELECT array_agg(fn_club_is_in_downline('{club}',md5('deep0')::uuid,md5(('deep'||i)::text)::uuid) ORDER BY i) FROM generate_series(0,22) i; SELECT fn_club_is_in_downline('{club}',NULL,md5('deep1')::uuid),fn_club_is_in_downline('{club}',md5('deep0')::uuid,NULL);"
 expected_boundaries=q(boundaries)
 q(f"UPDATE club_members SET agent_id=md5('deep2')::uuid WHERE user_id=md5('deep0')::uuid;")
 expected_cycle=q(boundaries)
 q(f"UPDATE club_members SET agent_id=NULL WHERE user_id=md5('deep0')::uuid;")
 expected=q(matrix)
 start=time.perf_counter();before=q(sql);before_ms=(time.perf_counter()-start)*1000
 q(new)
 start=time.perf_counter();after=q(sql);after_ms=(time.perf_counter()-start)*1000
 assert before==after
 assert q(matrix)==expected
 assert q(boundaries)==expected_boundaries
 q(f"UPDATE club_members SET agent_id=md5('deep2')::uuid WHERE user_id=md5('deep0')::uuid;")
 assert q(boundaries)==expected_cycle
 assert after_ms < before_ms*.5, (before_ms,after_ms,'indexed parent lookup lost its measured advantage')
 print(json.dumps({'members':5021,'lookups':100,'old_count':before,'new_count':after,'before_ms':round(before_ms,2),'after_ms':round(after_ms,2),'speedup':round(before_ms/after_ms,2)}))
finally:
 if (data/'postmaster.pid').exists():run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
 shutil.rmtree(w)
