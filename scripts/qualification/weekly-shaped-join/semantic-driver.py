from pathlib import Path
import json,subprocess,hashlib,uuid,datetime,collections,os
import argparse,os,sys,shutil,tempfile
PQUAL=Path(__file__).resolve().parent;ROOT=PQUAL.parents[2]
a=argparse.ArgumentParser();a.add_argument('--output',type=Path,required=True);args=a.parse_args();O=args.output.resolve();O.mkdir(parents=True,exist_ok=True)
for name,pin in json.loads((PQUAL/'source-binding.json').read_text())['files'].items():
 raw=(ROOT/name).read_bytes()
 if len(raw)!=pin['bytes'] or hashlib.sha256(raw).hexdigest()!=pin['sha256']:raise RuntimeError('qualification source input differs: '+name)
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
P=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin' else str(Path(shutil.which('psql')).parent)))
base=Path('/Volumes/SmarterWork/agent-work/weekly-shaped-join-01a13099') if sys.platform=='darwin' else O.parent
W=Path(tempfile.mkdtemp(prefix='semantic-',dir=base));D=W/'data';S=W/'socket';S.mkdir();PORT='56643';started=False
old=(PQUAL/'before-shaped.sql').read_text();new=(PQUAL/'after-shaped.sql').read_text();needle=old.split('   WHERE (SELECT CASE',1)[1].split(';\n ELSE',1)[0];assert '   WHERE (SELECT CASE' not in new;assert old.split(' ELSE\n',1)[1]==new.split(' ELSE\n',1)[1]
def run(args,name,input=None,expect=0):
 r=subprocess.run([str(x) for x in args],input=input,text=True,capture_output=True,timeout=40);(O/(name+'.stdout')).write_text(r.stdout);(O/(name+'.stderr')).write_text(r.stderr)
 if input is not None:(O/(name+'.sql')).write_text(input)
 assert r.returncode==expect,(name,r.returncode,r.stderr);return r.stdout.strip()
def sql(t,n):return run([P/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',S,'-p',PORT,'-U','postgres'],n,t)
def j(t,n):return json.loads(sql(t,n).splitlines()[-1])
def ident(n):return str(uuid.UUID(hashlib.md5(n.encode()).hexdigest()))
union='fade0000-0000-0000-0000-000000000001'; table=ident('native-table'); start='2026-10-05T07:00:00+00:00';end='2026-10-12T07:00:00+00:00'
def q(s):return "'"+str(s).replace("'","''")+"'"
rows=[];touches=[]
for i in range(1,65):
 scope={'game_union_id':union,'asset':'chips'};ev={'status':'ready','basis_certified':True,'all_players_included':True,'game_scope':scope.copy()};which=i%8
 if which==0:ev['status']='blocked'
 elif which==1:ev['basis_certified']=False
 elif which==2:ev['all_players_included']=False
 elif which==3:ev['game_scope']={'game_union_id':ident('other')}
 elif which==4:ev.pop('basis_certified')
 elif which==5:ev['basis_certified']='true'
 elif which==6:ev['status']=None
 if i==60:ev={}
 if i==61:ev={'status':True,'basis_certified':None}
 when=start if i==62 else end if i==63 else '2026-10-07T07:00:00+00:00'
 if i==64:scope={'game_union_id':ident('other')};ev['game_scope']=scope.copy()
 row={'table_id':table,'hand_number':i,'hand_id':ident('hand'+str(i)),'transaction_id':'1','recognized_at':when,'payload_hash':'payload'+str(i),'game_scope':scope,'evidence':ev};rows.append(row)
 if i%7!=0:
  touches.append({'table_id':table,'hand_number':i,'recognized_at':end if i%7==1 else None if i%7==2 else start if i%7==3 else when,'game_union_id':None if i%7==4 else ident('other') if i%7==5 else union,'shaped':i%7!=6,'accepted_rake':None,'participants':None})
try:
 run([P/'initdb','-D',D,'-U','postgres','-A','trust','--no-locale','-E','UTF8'],'init');run([P/'pg_ctl','-D',D,'-l',W/'postgres.log','-o',f"-k {S} -p {PORT} -h ''",'-w','start'],'start');started=True
 # Authentic owning column types/notnull/PK/FK and existing indexes; no economic/auth helper substitutions.
 setup="""CREATE TABLE union_pnl_transaction_frames(transaction_id xid8 PRIMARY KEY,observed_at timestamptz NOT NULL,book_start timestamptz NOT NULL);
 CREATE TABLE union_pnl_cash_outcomes(table_id uuid NOT NULL,hand_number bigint NOT NULL,hand_id uuid NOT NULL UNIQUE,transaction_id xid8 NOT NULL REFERENCES union_pnl_transaction_frames(transaction_id),recognized_at timestamptz NOT NULL,payload_hash text NOT NULL,game_scope jsonb NOT NULL,evidence jsonb NOT NULL,PRIMARY KEY(table_id,hand_number));
 CREATE INDEX outcomes_week ON union_pnl_cash_outcomes((game_scope->>'game_union_id'),recognized_at);
 CREATE INDEX outcomes_unaccepted ON union_pnl_cash_outcomes((game_scope->>'game_union_id'),recognized_at) WHERE evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR evidence->'game_scope' IS DISTINCT FROM game_scope;
 CREATE TABLE union_pnl_cash_outcome_touches(table_id uuid NOT NULL,hand_number bigint NOT NULL,recognized_at timestamptz,game_union_id text,shaped boolean NOT NULL,accepted_rake text,participants jsonb,PRIMARY KEY(table_id,hand_number));
 CREATE INDEX union_pnl_cash_outcome_touches_week ON union_pnl_cash_outcome_touches(game_union_id,recognized_at);
 INSERT INTO union_pnl_transaction_frames VALUES('1','2026-10-07 07:00Z','2026-10-05 07:00Z');
 """
 for r in rows:
  setup+='INSERT INTO union_pnl_cash_outcomes VALUES('+','.join(q(json.dumps(r[k]))+'::jsonb' if k in ['game_scope','evidence'] else q(r[k]) for k in ['table_id','hand_number','hand_id','transaction_id','recognized_at','payload_hash','game_scope','evidence'])+');\n'
 for t in touches:
  setup+='INSERT INTO union_pnl_cash_outcome_touches VALUES('+','.join('NULL' if t[k] is None else 'true' if t[k] is True else 'false' if t[k] is False else q(t[k]) for k in ['table_id','hand_number','recognized_at','game_union_id','shaped','accepted_rake','participants'])+');\n'
 sql(setup,'setup');rawrows=j("SELECT jsonb_build_object('outcomes',(SELECT jsonb_agg(to_jsonb(o) ORDER BY hand_number) FROM union_pnl_cash_outcomes o),'touches',(SELECT jsonb_agg(to_jsonb(h) ORDER BY hand_number) FROM union_pnl_cash_outcome_touches h));",'raw-inputs');rows=rawrows['outcomes'];touches=rawrows['touches'];tm={t['hand_number']:t for t in touches}
 def week(t,s,e):return t is not None and s is not None and e is not None and datetime.datetime.fromisoformat(s)<=datetime.datetime.fromisoformat(t)<datetime.datetime.fromisoformat(e)
 def shape(o):
  ev=o['evidence'];return ev.get('status')!='ready' or ev.get('basis_certified') is not True or ev.get('all_players_included') is not True or ev.get('game_scope')!=o['game_scope']
 cases=[('projected',union,start,end,True),('raw',union,start,end,False),('null-projected',union,start,end,None),('other',ident('none'),start,end,True),('null-union',None,start,end,True),('null-start',union,None,end,True),('null-end',union,start,None,True),('empty-period',union,end,start,True)]
 results=[]
 for label,u,s,e,pr in cases:
  expected=[]
  for o in rows:
   if u is None or o['game_scope'].get('game_union_id')!=u or not week(o['recognized_at'],s,e) or not shape(o):continue
   if pr:
    h=tm.get(o['hand_number'])
    if h is None or h['game_union_id']!=u or not week(h['recognized_at'],s,e) or h['shaped'] is not True:continue
   expected.append(o)
  outputs=[]
  for side,fn in [('old',old),('new',new)]:
   sql(fn+'; REVOKE ALL ON FUNCTION fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC;',label+'-'+side+'-install')
   args=','.join('NULL' if v is None else 'true' if v is True else 'false' if v is False else q(v) for v in [u,s,e,pr]);out=j("SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY hand_number),'[]') FROM fn_union_pnl_week_shaped_hands("+args+") o;",label+'-'+side);assert out==expected,(label,side);outputs.append(out)
  assert outputs[0]==outputs[1];results.append({'case':label,'expected_count':len(expected),'full_rows_equal':True})
 sql(old+'; REVOKE ALL ON FUNCTION fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC;','restore')
 c=j("SELECT jsonb_build_object('version',version(),'full_md5',md5(pg_get_functiondef('fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure)),'owner',(SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure),'secdef',(SELECT prosecdef FROM pg_proc WHERE oid='fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure));",'restored-catalog');assert c['full_md5']=='78b5d525a31a79ff1b13a5cfe0ddf739'
 result={'cases':results,'inverse_all_other_function_bytes':True,'authentic_schema_pk_notnull':True,'restored':c,'no_money_or_production_calls':True,'acceptance_limit':'Same complete composite inputs and unchanged actualf1d7/report FILTERs; no economic/posthand runtime helper called or stubbed.','performance_limit':'No native timing or production duration claim.'};(O/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
finally:
 if started:run([P/'pg_ctl','-D',D,'-m','fast','-w','stop'],'stop')
 shutil.rmtree(W);(O/'cleanup.json').write_text(json.dumps({'own_cluster_stopped':True,'own_cluster_removed':True,'production_calls':False}))
 for p in O.iterdir():p.chmod(0o600)
