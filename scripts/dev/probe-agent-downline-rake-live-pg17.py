#!/usr/bin/env python3
"""Current whole reader, isolated PG17 only. Controlled Auth, captured launch helpers.
Proves exact predicate placement, numerical parity and bounded materialized rows;
not production timing, real Auth transport or financial writes.
"""
import argparse, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
M=ROOT/'supabase/migrations/20261030082716_downline_rake_filters_players_before_materializing.sql'
F=ROOT/'scripts/dev/fixtures/agent-downline-rake-live/current.sql'
COVERED=ROOT/'supabase/migrations/20261030145010_downline_rake_aggregates_bounded_covered_periods.sql'
OLD='a.rake_amount > 0 AND a.player_id IS NOT NULL'
NEW=OLD+'\n       AND EXISTS (SELECT 1 FROM everyone e\n                    WHERE e.player_id = a.player_id AND e.club_id = a.club_id)'
def main(argv=None):
 if not __debug__: raise RuntimeError('Assertions required')
 p=argparse.ArgumentParser();p.add_argument('--evidence-dir',required=True,type=Path);a=p.parse_args(argv);a.evidence_dir.mkdir(parents=True,exist_ok=False)
 pg=Path(os.environ.get('PGBIN','/opt/homebrew/opt/postgresql@17/bin'))
 env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env.update(TZ='UTC',LC_ALL='C')
 runtime=Path(tempfile.mkdtemp(prefix='dr-',dir=os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or str(a.evidence_dir.parent)))
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
  # Auth is a controlled external boundary, never live Auth proof. The launch
  # helpers below are captured production definitions over synthetic boundaries.
  q("""CREATE FUNCTION fn_ca_authorized_agent_data_clubs(root uuid, club uuid) RETURNS uuid[] LANGUAGE plpgsql STABLE AS $$ BEGIN IF auth.uid() IS NOT NULL AND auth.uid()<>root THEN RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF; RETURN ARRAY(SELECT club_id FROM agents WHERE user_id=root AND status='active' AND (club IS NULL OR club_id=club)); END $$;
ALTER TABLE rake_attributions ADD COLUMN club_id uuid, ADD COLUMN created_at timestamptz, ADD COLUMN rake_amount numeric, ADD COLUMN rake_record_id uuid;
UPDATE rake_attributions a SET club_id=r.club_id,created_at=r.created_at,rake_amount=a.weighted_rake_credit,rake_record_id=r.id FROM rake_records r WHERE r.hand_id=a.hand_id;
CREATE INDEX ON rake_attributions(player_id,club_id,created_at);
CREATE UNIQUE INDEX ON rake_records(id);
""")
  q((ROOT/'scripts/dev/fixtures/agent-downline-rake-live/launch.sql').read_text())
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
  proof=next(line.removeprefix('-- @live-proof: ') for line in M.read_text().splitlines() if line.startswith('-- @live-proof: '))
  check('installed_proof_false_before_change',q('SELECT '+proof+';')=='f')
  q(M.read_text());after=definition()
  check('only_three_exact_predicate_changes',old.count(OLD)==3 and after==old.replace(OLD,NEW))
  check('identity_defaults_acl_owner_unchanged',meta()==before_meta)
  check('installed_proof_true_after_change',q('SELECT '+proof+';')=='t')
  after_count=edge_count(after);print(json.dumps({'edge_before':before_count,'edge_after':after_count}));check('foreign_players_excluded_before_materialization',before_count==after_count+120001 and after_count==6)
  candidate={name:read(**args) for name,args in cases}
  check('all_whole_reader_numeric_scope_search_limit_service_results_identical',candidate==baseline)
  try:read(actor=226);denied=False
  except RuntimeError as e:denied='not_authorised' in str(e)
  check('authorization_still_refused',denied)
  try:q(M.read_text());denied=False
  except RuntimeError as e:denied='target definition drift' in str(e)
  check('replay_refused_before_replacement',denied)
  # Qualify the bounded covered-period successor against the installed whole
  # reader, retaining all original eleven checks and their exact assertions.
  covered_proof=next(line.removeprefix('-- @live-proof: ') for line in COVERED.read_text().splitlines() if line.startswith('-- @live-proof: '))
  check('covered_proof_false_before',q('SELECT '+covered_proof+';')=='f')
  q(COVERED.read_text())
  check('covered_exact_whole_definition',definition().rstrip()==(ROOT/'scripts/dev/fixtures/agent-downline-rake-live/covered.sql').read_text().rstrip())
  check('covered_proof_true_after',q('SELECT '+covered_proof+';')=='t')
  check('covered_preserves_identity_authority_defaults',meta()==before_meta)
  covered={name:read(**args) for name,args in cases}
  check('covered_nonnull_launch_full_numeric_boundary_scope_parity',covered==baseline)
  try:read(actor=226);denied=False
  except RuntimeError as e:denied='not_authorised' in str(e)
  check('covered_authorization_refusal',denied)
  try:q(COVERED.read_text());denied=False
  except RuntimeError as e:denied='target definition drift' in str(e)
  check('covered_replay_refusal',denied)
  # NULL boundaries accept missing source records; nonNULL boundaries reject
  # missing/NULL/infinite/before-cutoff earnings but accept exact/after cutoff.
  q('DELETE FROM ca_launch_accounting_boundaries;')
  check('real_null_boundary_accepts_missing_and_nonfinite',q("SELECT bool_and(fn_ca_launch_accounting_accepts('"+uid(1)+"',x)) FROM unnest(ARRAY[NULL::timestamptz,'infinity','-infinity','2026-09-01']) x;")=='t')
  null_before=read()
  null_player=next(x for x in null_before if x['player_id']==uid(301))
  check('null_cutoff_independent_before_launch_row_accepted',float(null_player['rake_generated'])==114.03 and null_player['hands']==7)
  q("INSERT INTO ca_launch_accounting_boundaries VALUES('club','"+uid(1)+"','2026-09-08',NULL);")
  check('real_nonnull_boundary_null_infinite_before_equal_after',q("SELECT array_agg(fn_ca_launch_accounting_accepts('"+uid(1)+"',x) ORDER BY ord)::text FROM unnest(ARRAY[NULL::timestamptz,'infinity','-infinity','2026-09-07','2026-09-08','2026-09-09']) WITH ORDINALITY t(x,ord);")=='{f,f,f,f,t,t}')
  # Independent large-cohort stage:635authorized people,314291positive rows,
  # actual production club/date INCLUDE cover. No forced planner settings.
  q('TRUNCATE rake_attributions,rake_records,club_rake_daily_user; DELETE FROM ca_launch_accounting_boundaries;')
  q("CREATE INDEX idx_rake_attributions_club_created ON rake_attributions(club_id,created_at) INCLUDE(player_id,rake_amount);")
  q(f"INSERT INTO club_members(user_id,club_id,agent_id,role,status) SELECT md5('cohort'||g)::uuid,'{uid(1)}','{uid(100)}','player','active' FROM generate_series(1,632)g;")
  people_cte=f"WITH RECURSIVE ch AS(SELECT id,user_id,club_id FROM agents WHERE user_id='{uid(100)}' AND club_id='{uid(1)}' AND status='active' UNION ALL SELECT a.id,a.user_id,a.club_id FROM agents a JOIN ch ON a.parent_agent_id=ch.id AND a.club_id=ch.club_id WHERE a.status='active'), people AS(SELECT DISTINCT cm.user_id FROM club_members cm JOIN ch ON cm.agent_id=ch.user_id AND cm.club_id=ch.club_id UNION SELECT user_id FROM ch WHERE user_id<>'{uid(100)}')"
  check('large_actual_authorized_cohort635',q(people_cte+' SELECT count(*) FROM people;')=='635')
  q(people_cte+f" INSERT INTO rake_attributions(player_id,club_id,created_at,rake_amount,rake_record_id) SELECT p.user_id,'{uid(1)}',CASE g%3 WHEN 0 THEN '2026-09-08 13:00Z'::timestamptz WHEN 1 THEN '2026-09-10 13:00Z'::timestamptz ELSE '2026-09-11 13:00Z'::timestamptz END,0.015,md5('record'||g)::uuid FROM generate_series(1,314291) g JOIN(SELECT user_id,row_number()OVER(ORDER BY user_id)-1 n FROM people)p ON p.n=g%635;")
  # Each source record is independently keyed; positive-cutoff lane must use it.
  q("INSERT INTO rake_records(id,created_at) SELECT rake_record_id,'2026-09-10 00:00Z' FROM rake_attributions; VACUUM ANALYZE rake_attributions;")
  # Inspect the actual whole candidate CTE with literal parameter bindings.
  # The physical cover and period parameterization are part of the regression.
  import re
  whole=definition();whole=whole[whole.index('  WITH RECURSIVE chain AS ('):whole.rindex('END $function$')].strip().rstrip(';')
  vals={'v_root':"'"+uid(100)+"'::uuid",'p_club_id':"'"+uid(1)+"'::uuid",'v_authorized_clubs':"ARRAY['"+uid(1)+"']::uuid[]",'v_from':"'2026-09-08 12:00Z'::timestamptz",'v_to':"'2026-09-11 18:00Z'::timestamptz",'v_head_end':"'2026-09-09'::timestamptz",'v_tail_start':"'2026-09-11'::timestamptz",'v_day_lo':"'2026-09-09'::date",'v_day_hi':"'2026-09-11'::date",'p_search':'NULL::text','p_limit':'100000'}
  for k,v in vals.items():whole=re.sub(r'\b'+k+r'\b',v,whole)
  physical=json.loads(q('EXPLAIN(FORMAT JSON) '+whole))[0]['Plan']
  def nodes(n):
   yield n
   for child in n.get('Plans',[]):yield from nodes(child)
  covers=[n for n in nodes(physical) if n.get('Index Name')=='idx_rake_attributions_club_created' and n.get('Node Type')=='Index Only Scan']
  check('actual_whole_plan_uses_bounded_period_index_only_cover',any('created_at >=' in n.get('Index Cond','') and 'created_at <' in n.get('Index Cond','') for n in covers))
  large=read(limit=100000)
  check('large_null_cutoff_all635_314291_row_cents',len(large)==635 and sum(x['hands'] for x in large)==314291 and round(sum(float(x['rake_generated']) for x in large),2)==6285.82)
  q(f"INSERT INTO ca_launch_accounting_boundaries VALUES('club','{uid(1)}','2026-09-10',NULL);")
  large_cutoff=read(limit=100000)
  check('large_nonnull_cutoff_all635_source_record_parity',large_cutoff==large)
  q("UPDATE rake_records SET created_at='2026-09-09';")
  rejected=read(limit=100000)
  check('large_nonnull_cutoff_rejects314291_prelaunch_rows',sum(x['hands'] for x in rejected)==0 and sum(float(x['rake_generated']) for x in rejected)==0)
  check('large_metadata_unchanged',meta()==before_meta)
  result={'passed':len(checks),'checks':checks,'baseline':baseline,'candidate':candidate,'edge_rows_before':before_count,'edge_rows_after':after_count,'migration_sha256':hashlib.sha256(M.read_bytes()).hexdigest(),'fixture_sha256':hashlib.sha256(F.read_bytes()).hexdigest(),'covered_migration_sha256':hashlib.sha256(COVERED.read_bytes()).hexdigest(),'covered':covered,'physical_plan':physical,'large_members':len(large),'large_hands':sum(x['hands'] for x in large),'limits':'Actual whole current reader and exact migration. Reduced synthetic schema and controlled external authorization; captured real launch helpers over synthetic boundaries. No production timing or live Auth proof.'}
  (a.evidence_dir/'RESULT.json').write_text(json.dumps(result,indent=2));print(json.dumps({'passed':len(checks),'edge_rows_before':before_count,'edge_rows_after':after_count}))
 finally:
  if started:run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
  shutil.rmtree(runtime)
  (a.evidence_dir/'CLEANUP.json').write_text('{"private_cluster_stopped_removed":true}\n')
if __name__=='__main__':main()
