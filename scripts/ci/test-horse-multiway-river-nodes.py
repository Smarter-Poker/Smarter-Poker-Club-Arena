#!/usr/bin/env python3
"""Finite synthetic PG17 contract for the additive four-node public sidecar."""
import json, os, re, subprocess, sys, tempfile, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PG=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
BASE=Path(os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or tempfile.gettempdir())
if sys.platform=='darwin' and not str(BASE).startswith('/Volumes/SmarterWork/agent-work/'):
    raise RuntimeError('external SSD TMPDIR required')
ENV={k:v for k,v in os.environ.items() if not k.startswith('PG')}
ENV.update(LANG='C',LC_ALL='C')
def uid(n): return str(uuid.UUID(int=n))
def lit(v): return "'"+json.dumps(v).replace("'","''")+"'::jsonb"
def main():
  checks=[]
  with tempfile.TemporaryDirectory(prefix='hu-river-',dir=BASE) as raw, tempfile.TemporaryDirectory(prefix='hr-',dir=BASE.parent) as sock:
    data=Path(raw)/'data'
    def command(args,sql=None): return subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=ENV,timeout=60)
    def run(sql,ok=True):
      r=command([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55497','-U','postgres','-d','postgres'],sql)
      if (r.returncode==0)!=ok: raise AssertionError(r.stderr or r.stdout)
      return r.stdout.strip() if ok else r.stderr
    def check(name,yes):
      if not yes: raise AssertionError(name)
      checks.append(name)
    for args in [[PG/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale'],[PG/'pg_ctl','-D',data,'-l',Path(raw)/'pg.log','-o',f'-k {sock} -p 55497 -c listen_addresses= -c fsync=off','-w','start']]:
      r=command(args)
      if r.returncode: raise RuntimeError(r.stderr)
    try:
      run("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('request.jwt.claim.role',true)$$; CREATE TABLE profiles(id uuid PRIMARY KEY,is_horse boolean,status text,horse_status text); CREATE TABLE ca_horse_fleet_register(horse_id uuid PRIMARY KEY,retired_at timestamptz); CREATE TABLE hand_history(id uuid PRIMARY KEY,game_variant text,actions jsonb,players jsonb,table_id uuid,tournament_id uuid,ended_at timestamptz,hand_number bigint,big_blind numeric); CREATE TABLE ca_hand_facts(hand_id uuid,user_id uuid,tournament_id uuid,played_at timestamptz,game_variant text,seat smallint,players_dealt smallint,table_id uuid,position text,PRIMARY KEY(hand_id,user_id));")
      run(f"INSERT INTO profiles VALUES('{uid(1)}',true,'active','available'); INSERT INTO ca_horse_fleet_register VALUES('{uid(1)}',NULL);")
      migration=ROOT/'supabase/migrations/20261027200734_horse_multiway_river_public_sidecar.sql'
      run(migration.read_text())
      definition=run("SELECT md5(pg_get_functiondef('public.fn_horse_multiway_river_nodes_v1(uuid,text,integer,timestamptz,jsonb)'::regprocedure));")
      pin=(ROOT/'server/src/engine/horseDecision/riverNodeSidecar.ts').read_text()
      print('Native definition MD5: '+definition)
      check('native definition equals runtime pin',re.search(r"HORSE_RIVER_NODE_DEFINITION_MD5 = '([a-f0-9]{32})'",pin).group(1)==definition)
      acts=[dict(seat=1+i%2,userId=uid(1+i%2),action=a,amount=v,stage='river',timestamp=i+1) for i,(a,v) in enumerate([('check',0),('bet',2),('raise',6),('fold',0)])]
      stored=[dict(a,publicNode=dict(version=1,status='captured',variant='nlh',mode='cash',seats=[[1,100,0,2,0,0,0],[2,100,0,2,0,0,0],[3,100,0,2,0,0,1]],boards=['AhKdQcJs2c'],legalActions=['check'],private='SECRET')) for a in acts]
      run(f"INSERT INTO hand_history VALUES('{uid(100)}','nlh',{lit(stored)},'{json.dumps(['SECRET'])}'::jsonb,'{uid(300)}',NULL,'2026-10-27T12:00:00Z',1000001,2); INSERT INTO ca_hand_facts VALUES('{uid(100)}','{uid(1)}',NULL,'2026-10-27T12:00:00Z','nlh',1,3,'{uid(300)}','SB');")
      bindings=[dict(handId=uid(100),actions=acts,binding='a'*64)]
      def read(b=bindings,actor=1,count=3,role='service_role',claim='service_role',ok=True):
        out=run(f"SET ROLE {role}; SET request.jwt.claim.role='{claim}'; SELECT public.fn_horse_multiway_river_nodes_v1('{uid(actor)}','nlh',{count},'2026-10-27T13:00:00Z',{lit(b)});",ok)
        return (json.loads(out) if out else None) if ok else out
      first=read();check('runtime pin returned',first['definitionMd5']==definition);check('exact four public nodes retained',len(first['hands'][0]['nodes'])==4)
      check('private input excluded','SECRET' not in json.dumps(first) and 'private' not in json.dumps(first))
      check('original action binding returned',first['hands'][0]['binding']=='a'*64)
      changed=json.loads(json.dumps(bindings));changed[0]['actions'][1]['amount']=99
      check('changed action refuses enrichment',read(changed)['hands'][0]['reason']=='action_binding_mismatch')
      check('other original population unavailable',read(count=4)['hands'][0]['reason']=='original_context_unavailable')
      check('foreign observer unavailable',read(actor=2) is None)
      check('duplicate hands refused','duplicate hand identity' in read(bindings*2,ok=False))
      check('oversize request refused','invalid river sidecar request' in read(bindings*65,ok=False))
      for role in ['anon','authenticated']:
        check(role+' ACL enforced','permission denied' in read(role=role,ok=False))
      check('service claim enforced','service_role required' in read(claim='authenticated',ok=False))
      for length in [2,3]:
        partial=[dict(handId=uid(100),actions=acts[:length],binding='b'*64)]
        run(f"UPDATE hand_history SET actions={lit(stored[:length])};")
        check('two-node denominator retained from '+str(length)+' actions',len(read(partial)['hands'][0]['nodes'])==2)
      run(f"UPDATE hand_history SET actions={lit(stored)};")
      run(f"UPDATE hand_history SET actions=jsonb_set(actions,'{{0,publicNode,seats}}','[{{\"private\":\"SECRET\"}}]'::jsonb) WHERE id='{uid(100)}';")
      check('malformed tuple never copied','SECRET' not in json.dumps(read()))
      for column,value in [('table_id',f"'{uid(301)}'"),('ended_at',"'2026-10-27T12:01:00Z'"),('tournament_id',f"'{uid(200)}'")]:
        run(f"UPDATE hand_history SET {column}={value};")
        check('facts/history mismatch '+column,read()['hands'][0]['status']=='unavailable')
        restore={'table_id':f"'{uid(300)}'",'ended_at':"'2026-10-27T12:00:00Z'",'tournament_id':'NULL'}
        run(f"UPDATE hand_history SET {column}={restore[column]};")
      run(f"UPDATE ca_hand_facts SET tournament_id='{uid(200)}';")
      check('cash cannot import tournament nodes',read()['hands'][0]['status']=='unavailable')
      print(json.dumps(dict(passed=len(checks),checks=checks,definitionMd5=definition)))
    finally:
      r=command([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
      if r.returncode: raise RuntimeError(r.stderr)
if __name__=='__main__': main()
