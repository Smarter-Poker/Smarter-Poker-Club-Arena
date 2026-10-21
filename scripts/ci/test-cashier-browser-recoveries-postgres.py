#!/usr/bin/env python3
"""Actual PG17 qualification of actor-scoped browser-independent recovery."""
import copy, hashlib, json, os, shutil, subprocess, tempfile, uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PG=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if Path('/Volumes/SmarterWork').exists() else '/usr/lib/postgresql/17/bin'))
cluster=Path(tempfile.mkdtemp(prefix='cr-',dir=os.environ.get('TMPDIR',os.environ.get('RUNNER_TEMP')))); sock=cluster/'s';sock.mkdir()
A='00000000-0000-0000-0000-000000000001'; C='00000000-0000-0000-0000-000000000002'; B='00000000-0000-0000-0000-000000000003'
T=['00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005']
def run(cmd,text=None):
 p=subprocess.run([str(v) for v in cmd],input=text,text=True,capture_output=True,timeout=60)
 if p.returncode:raise RuntimeError(p.stderr[-6000:]+p.stdout[-1000:])
 return p.stdout.strip()
def q(sql):return run([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-U','postgres','-d','postgres'],sql)
def lit(v):return "'"+str(v).replace("'","''")+"'"
def js(v):return lit(json.dumps(v,separators=(',',':')))+'::jsonb'
def call(fn,args,actor=A):return q('SET request.jwt.claim.sub='+lit(actor)+';SET ROLE authenticated; SELECT fn_cashier_browser_recovery_'+fn+'('+','.join(args)+');').splitlines()[-1]
def key(e):return hashlib.sha256(json.dumps({k:v for k,v in e.items() if k not in ('submissionId','opIds','failures','createdAt')},sort_keys=True,separators=(',',':')).encode()).hexdigest()
def scope(kind,k):return [lit(A),lit(C),lit(kind),lit(k)]
def reserve(kind,k,e,actor=A):return json.loads(call('reserve',scope(kind,k)+[js(e)],actor))
def update(k,e,identity=None):return call('update',scope('transfer',k)+[lit(identity or e['submissionId']),js(e)])
def denied(fn):
 try:fn()
 except RuntimeError:return
 raise AssertionError('invalid request accepted')
started=False
try:
 run([PG/'initdb','-D',cluster/'data','-U','postgres','-A','trust','--no-locale','-E','UTF8'])
 run([PG/'pg_ctl','-D',cluster/'data','-l',cluster/'log','-o',f"-h '' -k {sock}",'-w','start']);started=True
 assert q("SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses')='';")=='t'
 q("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;CREATE TABLE club_members(club_id uuid,user_id uuid,status text,role text);CREATE FUNCTION fn_club_cashier_scope(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT CASE WHEN EXISTS(SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 AND role IN ('owner','agent') AND status IN ('active','approved')) THEN 'downline' ELSE 'none' END $$;")
 q(f"INSERT INTO club_members VALUES('{C}','{A}','active','agent');")
 assert q("SELECT to_regprocedure('fn_cashier_browser_recovery_reserve(uuid,uuid,text,text,jsonb)') IS NULL;")=='t'
 q((ROOT/'supabase/migrations/20261021182432_cashier_recovery_survives_unavailable_browser_storage.sql').read_text())
 w=dict(version=1,userId=A,clubId=C,action='fn_agent_wallet_send',digest='a'*64,operationId=str(uuid.uuid4()),createdAt=1)
 wk=w['action']+':'+w['digest'];assert reserve('wallet',wk,w)==w
 draft={**w,'operationId':str(uuid.uuid4()),'createdAt':2}
 with ThreadPoolExecutor(max_workers=4) as pool:r=list(pool.map(lambda _:reserve('wallet',wk,draft),range(4)))
 assert all(e==w for e in r),'legacy identity must survive duplicate/concurrent reservations'
 alias={**w,'digest':'b'*64};denied(lambda:reserve('wallet',alias['action']+':'+alias['digest'],alias))
 e=dict(version=1,userId=A,clubId=C,kind='send',amount=10,targetIds=T,targetAmounts={t:10 for t in T},failures=[dict(userId=t,name='Player',message='Unresolved') for t in T],submissionId=str(uuid.uuid4()),opIds={t:str(uuid.uuid4()) for t in T},destinations={t:'player_wallet' for t in T},source='agent_wallet',createdAt=1)
 k=key(e)
 def race(_):return reserve('transfer',k,{**e,'submissionId':str(uuid.uuid4()),'opIds':{t:str(uuid.uuid4()) for t in T}})
 with ThreadPoolExecutor(max_workers=4) as pool:r=list(pool.map(race,range(4)))
 assert all(v==r[0] for v in r);e=r[0]
 left={**e,'failures':e['failures'][:1]};right={**e,'failures':e['failures'][1:]}
 with ThreadPoolExecutor(max_workers=2) as pool:raced=list(pool.map(lambda candidate:update(k,candidate),[left,right]))
 assert sorted(raced)==['f','t'],'concurrent failures cannot re-expand each other'
 narrowed=json.loads(call('read',[lit(A),lit(C),lit('transfer')]))[0]
 assert update(k,narrowed)=='t';assert update(k,e)=='f'
 assert reserve('transfer',k,e)==narrowed,'reservation must not reset progress'
 assert update(k,narrowed,str(uuid.uuid4()))=='f'
 for field,value in [('amount',11),('source','club_bank'),('targetIds',T[:1]),('version',2),('clubId',B),('userId',B),('submissionId',str(uuid.uuid4())),('createdAt',2),('opIds',{t:str(uuid.uuid4()) for t in T})]:
  changed={**narrowed,field:value}
  try:result=update(k,changed)
  except RuntimeError:continue
  assert result=='f',field
 assert update(k,{**narrowed,'failures':[dict(userId=next(t for t in T if t != narrowed['failures'][0]['userId']),name='Player',message='Unresolved')]})=='f'
 denied(lambda:update(k,{**narrowed,'failures':[]}))
 for changed in [{**e,'amount':0},{**e,'amount':1.001},{**e,'amount':1000000001},{**e,'targetIds':[T[0],T[0]]},{**e,'extra':True},{**e,'createdAt':-1},{**e,'opIds':{}},{**e,'failures':[dict(userId=B,name='Player',message='Unknown')]},{**e,'failures':[dict(userId=T[0],name='x'*201,message='Unknown')]}]:
  denied(lambda changed=changed:reserve('transfer',key(changed),changed))
 for malformed in [None,[],42,'invalid',True,{**e,'targetIds':{}},{**e,'failures':{}},{**e,'opIds':[]},{**e,'amount':'invalid'},{**e,'createdAt':'invalid'},{**e,'destinations':[]},{**e,'targetAmounts':[]}]:
  denied(lambda malformed=malformed:reserve('transfer',k,malformed))
 denied(lambda:reserve('wallet',wk,{**w,'digest':'invalid'}))
 denied(lambda:reserve('wallet',wk,w,actor=B));denied(lambda:reserve('wallet',wk,w,actor=''))
 denied(lambda:call('read',[lit(A),lit(C),lit('wallet')],actor=B))
 denied(lambda:call('ack',scope('wallet',wk)+[lit(w['operationId'])],actor=B))
 assert call('read',[lit(A),lit(B),lit('wallet')])=='[]'
 assert call('ack',scope('transfer',k)+[lit(str(uuid.uuid4()))])=='f'
 q(f"UPDATE club_members SET role='player' WHERE user_id='{A}';")
 assert json.loads(call('read',[lit(A),lit(C),lit('transfer')]))==[narrowed]
 assert update(k,narrowed)=='t'
 denied(lambda:reserve('wallet',wk,w))
 assert call('ack',scope('transfer',k)+[lit(e['submissionId'])])=='t'
 q(f"UPDATE club_members SET role='agent',status='inactive' WHERE user_id='{A}';")
 denied(lambda:reserve('wallet',wk,w))
 assert call('ack',scope('wallet',wk)+[lit(w['operationId'])])=='t'
 q(f"UPDATE club_members SET status='approved' WHERE user_id='{A}';")
 assert reserve('wallet',wk,draft)==draft
 assert call('ack',scope('wallet',wk)+[lit(w['operationId'])])=='f'
 assert json.loads(call('read',[lit(A),lit(C),lit('wallet')]))==[draft]
 denied(lambda:q('SET ROLE authenticated;SELECT * FROM cashier_browser_recoveries;'))
 denied(lambda:q('SET ROLE authenticated;INSERT INTO cashier_browser_recoveries DEFAULT VALUES;'))
 assert q("SELECT relrowsecurity FROM pg_class WHERE oid='cashier_browser_recoveries'::regclass;")=='t'
 assert q("SELECT count(*)=0 FROM pg_constraint WHERE conrelid='cashier_browser_recoveries'::regclass AND contype='f';")=='t'
 assert q("SELECT bool_and(p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_temp'] AND has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')) FROM pg_proc p WHERE proname IN ('fn_cashier_browser_recovery_reserve','fn_cashier_browser_recovery_read','fn_cashier_browser_recovery_update','fn_cashier_browser_recovery_ack');")=='t'
 assert q("SELECT bool_and(NOT has_function_privilege('authenticated',oid,'EXECUTE')) FROM pg_proc WHERE proname IN ('fn_cashier_browser_recovery_valid','fn_cashier_browser_recovery_canonical');")=='t'
 assert q("SELECT NOT fn_cashier_browser_recovery_valid('"+A+"','"+C+"','wallet','x',jsonb_build_object('payload',repeat('x',16777217)));")=='t'
 print('PASS: PG17 recovery legacy identity, concurrent reservation, immutable intent/operation IDs, failure narrowing, stale compare-delete, auth/role loss, malformed boundaries, size, RLS and authenticated-only ACLs; no funds or expiry')
finally:
 if started:run([PG/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
 shutil.rmtree(cluster)
