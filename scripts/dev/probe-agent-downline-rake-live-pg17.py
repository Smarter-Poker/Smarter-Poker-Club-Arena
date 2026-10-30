#!/usr/bin/env python3
"""Current whole reader, isolated PG17 only. Controlled external auth/launch authorities.
Proves exact predicate placement, numerical parity and bounded materialized rows;
not production timing, real Auth transport or financial writes.
"""
import argparse, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
M=ROOT/'supabase/migrations/20261030082716_downline_rake_filters_players_before_materializing.sql'
F=ROOT/'scripts/dev/fixtures/agent-downline-rake-live/current.sql'
OLD='a.rake_amount > 0 AND a.player_id IS NOT NULL'
NEW=OLD+'\n       AND EXISTS (SELECT 1 FROM everyone e\n                    WHERE e.player_id = a.player_id AND e.club_id = a.club_id)'
def main():
 if not __debug__: raise RuntimeError('Assertions required')
 p=argparse.ArgumentParser();p.add_argument('--evidence-dir',required=True,type=Path);a=p.parse_args();a.evidence_dir.mkdir(parents=True,exist_ok=False)
 pg=Path(os.environ.get('PGBIN','/opt/homebrew/opt/postgresql@17/bin'))
 env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env.update(TZ='UTC',LC_ALL='C')
 runtime=Path(tempfile.mkdtemp(prefix='dr-',dir=os.environ.get('TMPDIR',str(a.evidence_dir.parent))))
 socket=runtime/'s';socket.mkdir();data=runtime/'d';port=str(45000+os.getpid()%10000);started=False;checks=[]
 def run(args,sql=None):
  r=subprocess.run([str(x) for x in args],input=sql,text=True,capture_output=True,env=env,timeout=45)
  if r.returncode:raise RuntimeError(r.stderr)
  return r.stdout.strip()
 def q(sql):return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','postgres','postgres'],sql)
 def check(name,ok):checks.append({'case':name,'pass':bool(ok)});assert ok,name
 def uid(i):return f'00000000-0000-4000-8000-{i:012d}'
 signature='public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer)'
 def definition():return q("SELECT pg_get_functiondef('"+signature+"'::regprocedure);")+'\n'
 try:
  check('postgres17',run([pg/'postgres','--version']).startswith('postgres (PostgreSQL) 17.'))
  run([pg/'initdb','-D',data,'-U','postgres','--auth=trust','--no-locale','-E','UTF8'])
  run([pg/'pg_ctl','-D',data,'-l',runtime/'log','-o',f"-k {socket} -p {port} -c listen_addresses=''",'-w','start']);started=True
  q((ROOT/'scripts/dev/fixtures/agent-downline-rake-scope/bootstrap.sql').read_text())
  # Controlled external boundaries preserve the reader's authorization call and
  # launch predicate. They are intentionally not claimed as current Auth proof.
  q("""CREATE FUNCTION fn_ca_authorized_agent_data_clubs(root uuid, club uuid) RETURNS uuid[] LANGUAGE plpgsql STABLE AS $$ BEGIN IF auth.uid() IS NOT NULL AND auth.uid()<>root THEN RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF; RETURN ARRAY(SELECT club_id FROM agents WHERE user_id=root AND status='active' AND (club IS NULL OR club_id=club)); END $$;
CREATE FUNCTION fn_ca_launch_accounting_accepts(club uuid, earned timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT earned>='2026-09-08 00:00Z'::timestamptz $$;
ALTER TABLE rake_attributions ADD COLUMN club_id uuid, ADD COLUMN created_at timestamptz, ADD COLUMN rake_amount numeric, ADD COLUMN rake_record_id uuid;
UPDATE rake_attributions a SET club_id=r.club_id,created_at=r.created_at,rake_amount=a.weighted_rake_credit,rake_record_id=r.id FROM rake_records r WHERE r.hand_id=a.hand_id;
CREATE INDEX ON rake_attributions(player_id,club_id,created_at);
CREATE UNIQUE INDEX ON rake_records(id);
""")
  q(F.read_text()+f'; REVOKE ALL ON FUNCTION {signature} FROM PUBLIC; GRANT EXECUTE ON FUNCTION {signature} TO authenticated,service_role;')
  check('exact_live_preimage',q(f"SELECT md5(pg_get_functiondef('{signature}'::regprocedure));")=='c950d72d7b9db73b8fdb1a706441291c')
  # One authorized player: head (including exact start), missing day, rolled
  # day, tail. Extra rows test exclusive end, before start, launch and cents.
  rows=[('2026-09-08 12:00Z','1.005','2026-09-08 12:00Z'),('2026-09-08 11:59Z','99','2026-09-08 11:59Z'),('2026-09-10 10:00Z','2.005','2026-09-10 10:00Z'),('2026-09-11 12:00Z','3.005','2026-09-11 12:00Z'),('2026-09-11 18:00Z','99','2026-09-11 18:00Z'),('2026-09-10 11:00Z','99','2026-09-07 00:00Z'),('2026-09-10 11:01Z','0','2026-09-10 11:01Z')]
  for i,(at,amount,earned) in enumerate(rows,9000):
   q(f"INSERT INTO rake_records(id,created_at) VALUES('{uid(i)}','{earned}'); INSERT INTO rake_attributions(player_id,club_id,created_at,rake_amount,rake_record_id) VALUES('{uid(301)}','{uid(1)}','{at}',{amount},'{uid(i)}');")
  # Large unrelated cohort in the SAME authorized club, spread across all
  # three source branches. No index/constraint settings are forced.
  q(f"INSERT INTO rake_attributions(player_id,club_id,created_at,rake_amount) SELECT md5('foreign'||g)::uuid,'{uid(1)}',CASE g%3 WHEN 0 THEN '2026-09-08 13:00Z'::timestamptz WHEN 1 THEN '2026-09-10 13:00Z'::timestamptz ELSE '2026-09-11 13:00Z'::timestamptz END,7 FROM generate_series(1,120000) g; ANALYZE rake_attributions;")
  def meta():return q(f"SELECT jsonb_build_array(oid,proowner,proacl,proconfig,provolatile,prosecdef,pronargdefaults,pg_get_function_arguments(oid)) FROM pg_proc WHERE oid='{signature}'::regprocedure;")
  before_meta=meta()
  def read(actor=100,since='2026-09-08 12:00Z',until='2026-09-11 18:00Z',search=None,limit=500):
   claims=json.dumps({'role':'authenticated','sub':uid(actor)}) if actor else '{"role":"service_role"}'
   search_sql='NULL' if search is None else "'"+search+"'"
   return json.loads(q(f"BEGIN; SET LOCAL statement_timeout='5s'; SELECT set_config('request.jwt.claims','{claims}',true); SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY club_id,player_id),'[]') FROM fn_agent_downline_rake('{uid(100)}','{uid(1)}','{since}','{until}',{search_sql},{limit}) x; ROLLBACK;").splitlines()[-1])
  cases=[('mixed',{}),('head_only',{'until':'2026-09-08 18:00Z'}),('gap_only',{'since':'2026-09-10 00:00Z','until':'2026-09-11 00:00Z'}),('tail_only',{'since':'2026-09-11 00:00Z'}),('search',{'search':'alias301'}),('limit',{'limit':1}),('service',{'actor':None})]
  baseline={name:read(**args) for name,args in cases}
  player=next(r for r in baseline['mixed'] if r['player_id']==uid(301))
  check('independent_head_gap_rollup_tail_cent_oracle',float(player['rake_generated'])==15.03 and player['hands']==6)
  def edge_count(d):
   # Actual original CTE block; replace only PL/pgSQL local parameter names
   # with literal fixture values, then observe materialization row cardinality.
   cte=d[d.index('  WITH RECURSIVE chain AS ('):d.index('  edge_split AS MATERIALIZED (')].rstrip().rstrip(',')
   vals={'v_root':"'"+uid(100)+"'::uuid",'p_club_id':"'"+uid(1)+"'::uuid",'v_authorized_clubs':"ARRAY['"+uid(1)+"']::uuid[]",'v_from':"'2026-09-08 12:00Z'::timestamptz",'v_to':"'2026-09-11 18:00Z'::timestamptz",'v_head_end':"'2026-09-09 00:00Z'::timestamptz",'v_tail_start':"'2026-09-11 00:00Z'::timestamptz",'v_day_lo':"'2026-09-09'::date",'v_day_hi':"'2026-09-11'::date"}
   import re
   for k,v in vals.items():cte=re.sub(r'\b'+k+r'\b',v,cte)
   return int(q(cte+' SELECT count(*) FROM edge_att;'))
  old=definition();before_count=edge_count(old)
  q(M.read_text());after=definition()
  check('only_three_exact_predicate_changes',old.count(OLD)==3 and after==old.replace(OLD,NEW))
  check('identity_defaults_acl_owner_unchanged',meta()==before_meta)
  after_count=edge_count(after);print(json.dumps({'edge_before':before_count,'edge_after':after_count}));check('foreign_players_excluded_before_materialization',before_count==after_count+120001 and after_count==6)
  candidate={name:read(**args) for name,args in cases}
  check('all_whole_reader_numeric_scope_search_limit_service_results_identical',candidate==baseline)
  try:read(actor=226);denied=False
  except RuntimeError as e:denied='not_authorised' in str(e)
  check('authorization_still_refused',denied)
  try:q(M.read_text());denied=False
  except RuntimeError as e:denied='target definition drift' in str(e)
  check('replay_refused_before_replacement',denied)
  result={'passed':len(checks),'checks':checks,'baseline':baseline,'candidate':candidate,'edge_rows_before':before_count,'edge_rows_after':after_count,'migration_sha256':hashlib.sha256(M.read_bytes()).hexdigest(),'fixture_sha256':hashlib.sha256(F.read_bytes()).hexdigest(),'limits':'Actual whole current reader and exact migration. Reduced synthetic schema and controlled external authorization/launch helpers; no production timing or live Auth proof.'}
  (a.evidence_dir/'RESULT.json').write_text(json.dumps(result,indent=2));print(json.dumps({'passed':len(checks),'edge_rows_before':before_count,'edge_rows_after':after_count}))
 finally:
  if started:run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
  shutil.rmtree(runtime)
  (a.evidence_dir/'CLEANUP.json').write_text('{"private_cluster_stopped_removed":true}\n')
if __name__=='__main__':main()
