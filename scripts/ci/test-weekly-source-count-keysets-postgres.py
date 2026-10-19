#!/usr/bin/env python3
"""Execute original and atomic historical terms on an isolated PG17, never production."""
import argparse,json,os,re,shutil,socket,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True)
a=ap.parse_args();root=Path(__file__).resolve().parents[2]
base=Path(tempfile.mkdtemp(prefix='rd-',dir=a.scratch));data=base/'d';started=False
with socket.socket() as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
env={**os.environ,'TMPDIR':str(base)}
def run(args,content=None,error=None):
 p=subprocess.run([str(x) for x in args],input=content,text=True,capture_output=True,env=env,timeout=90)
 if error:assert p.returncode and error in p.stderr,p.stdout+p.stderr
 else:assert p.returncode==0,p.stdout+p.stderr
 return p.stdout.strip()
def sql(s,error=None):return run([a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],s,error)
try:
 run([a.pg_bin/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([a.pg_bin/'pg_ctl','-D',data,'-l',base/'log','-o',f'-h 127.0.0.1 -k {base} -p {port}','-w','start']);started=True
 sql("""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE TABLE clubs(id uuid PRIMARY KEY,is_union boolean,union_id uuid);
 CREATE TABLE rake_records(id uuid PRIMARY KEY,hand_id uuid,club_id uuid,rake_amount numeric,created_at timestamptz,is_tournament boolean,tournament_id uuid,table_id uuid,metadata jsonb);
 CREATE TABLE rake_attributions(id uuid PRIMARY KEY,rake_record_id uuid,hand_id uuid,player_id uuid,club_id uuid,weighted_rake_credit numeric);
 CREATE INDEX attr_record ON rake_attributions(rake_record_id);
 CREATE TABLE accounting_cash_accrual_batches(rake_record_id uuid PRIMARY KEY,status text);
 CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY,rake_record_id uuid,player_id uuid,club_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb,union_id uuid,coordinator_union_id uuid);
 CREATE INDEX source_record ON accounting_cash_rake_sources(rake_record_id,player_id);
 CREATE INDEX source_period ON accounting_cash_rake_sources(club_id,earned_at);
 CREATE INDEX record_created ON rake_records(created_at);
 CREATE FUNCTION fn_ca_launch_accounting_start(text,uuid,timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT $3$$;
 CREATE FUNCTION fn_rake_record_is_ghost_twin(uuid,uuid,jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT false$$;
 INSERT INTO clubs VALUES('10000000-0000-0000-0000-000000000001',false,NULL),('10000000-0000-0000-0000-000000000002',false,NULL);
 INSERT INTO rake_records SELECT md5('record-'||g)::uuid,md5('hand-'||g)::uuid,'10000000-0000-0000-0000-000000000001',1,'2026-10-12 08:00Z',false,NULL,NULL,'{}' FROM generate_series(1,3)g;
 INSERT INTO rake_records SELECT md5('filler-'||g)::uuid,md5('fh-'||g)::uuid,'10000000-0000-0000-0000-000000000002',1,'2026-09-01',false,NULL,NULL,'{}' FROM generate_series(1,6000)g;
 INSERT INTO rake_attributions SELECT md5('attr-'||id)::uuid,id,hand_id,md5('player-'||id)::uuid,club_id,1 FROM rake_records;
 INSERT INTO accounting_cash_accrual_batches SELECT id,'accrued' FROM rake_records;
 INSERT INTO accounting_cash_rake_sources SELECT md5('src-'||r.id)::uuid,r.id,a.player_id,a.club_id,r.created_at,1,jsonb_build_object('attribution_id',a.id,'player_id',a.player_id,'club_id',a.club_id,'union_id',NULL,'coordinator_union_id',NULL),NULL,NULL FROM rake_records r JOIN rake_attributions a ON a.rake_record_id=r.id;
 ANALYZE;""")
 pre=json.loads((root/'scripts/ci/fixtures/weekly-source-count-preimage.json').read_text())
 sql(pre['definition']);sig='fn_rakeback_split_counts(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'
 assert sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")==pre['md5']
 sql('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;')
 meta="SELECT jsonb_build_array(proowner,proacl,prosecdef,provolatile,proconfig) FROM pg_proc WHERE oid='"+sig+"'::regprocedure"
 before_meta=sql(meta)
 call="SELECT fn_rakeback_split_counts('10000000-0000-0000-0000-000000000001','2026-10-12 07:00Z','2026-10-19 07:00Z','2026-10-12 07:00Z','2026-10-12 09:00Z')"
 rid="md5('record-1')::uuid";aid="md5('attr-'||md5('record-1')::uuid)::uuid"
 cases=[('clean','',(0,0,0)),
 ('empty_window','DELETE FROM accounting_cash_rake_sources;DELETE FROM accounting_cash_accrual_batches;DELETE FROM rake_attributions;DELETE FROM rake_records',(0,0,0)),
 ('null_source_key',"INSERT INTO accounting_cash_rake_sources SELECT md5('null-extra')::uuid,NULL,player_id,club_id,earned_at,1,contract,union_id,coordinator_union_id FROM accounting_cash_rake_sources WHERE rake_record_id="+rid,(0,0,1)),
 ('missing_source','DELETE FROM accounting_cash_rake_sources WHERE rake_record_id='+rid,(0,1,0)),
 ('missing_batch','DELETE FROM accounting_cash_accrual_batches WHERE rake_record_id='+rid,(0,1,1)),
 ('missing_attribution','DELETE FROM rake_attributions WHERE rake_record_id='+rid,(1,0,1)),
 ('wrong_hand',"UPDATE rake_attributions SET hand_id=md5('wrong')::uuid WHERE rake_record_id="+rid,(1,0,1)),
 ('wrong_contract',"UPDATE accounting_cash_rake_sources SET contract=jsonb_set(contract,'{club_id}',to_jsonb('wrong'::text)) WHERE rake_record_id="+rid,(0,1,0)),
 ('wrong_total','UPDATE rake_records SET rake_amount=2 WHERE id='+rid,(1,0,0)),
 ('wrong_batch',"UPDATE accounting_cash_accrual_batches SET status='blocked' WHERE rake_record_id="+rid,(0,1,1)),
 ('wrong_scope',"UPDATE accounting_cash_rake_sources SET contract=jsonb_set(contract,'{union_id}',to_jsonb(md5('wrong')::uuid)) WHERE rake_record_id="+rid,(0,0,1)),
 ('tournament','UPDATE rake_records SET is_tournament=true WHERE id='+rid,(0,0,1)),
 ('extra_source',"INSERT INTO accounting_cash_rake_sources SELECT md5('extra')::uuid,md5('missing')::uuid,player_id,club_id,earned_at,1,contract,union_id,coordinator_union_id FROM accounting_cash_rake_sources WHERE rake_record_id="+rid,(0,0,1)),
 ('outside_window',"UPDATE rake_records SET created_at='2026-10-12 10:00Z' WHERE id="+rid+";UPDATE accounting_cash_rake_sources SET earned_at='2026-10-12 10:00Z' WHERE rake_record_id="+rid,(0,0,0)),
 ('left_boundary',"UPDATE rake_records SET created_at='2026-10-12 07:00Z' WHERE id="+rid+";UPDATE accounting_cash_rake_sources SET earned_at='2026-10-12 07:00Z' WHERE rake_record_id="+rid,(0,0,0)),
 ('right_boundary',"UPDATE rake_records SET created_at='2026-10-12 09:00Z' WHERE id="+rid+";UPDATE accounting_cash_rake_sources SET earned_at='2026-10-12 09:00Z' WHERE rake_record_id="+rid,(0,0,0))]
 def verify():
  results=[]
  for mode in ['force_generic_plan','force_custom_plan']:
   for name,change,expected in cases:
    out=sql('BEGIN;SET LOCAL plan_cache_mode='+mode+';'+change+(';' if change else '')+call+';ROLLBACK;')
    got=json.loads(out);assert tuple(got[k] for k in ['evidence','incomplete','drifted'])==expected,(mode,name,got,expected)
    results.append((mode,name,got))
  return results
 old=verify()
 candidate=next((root/'supabase/migrations').glob('20261019184904_*')).read_text();sql(candidate)
 assert verify()==old
 assert sql(meta)==before_meta
 post=sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")
 assert sql("SELECT (length(prosrc)-length(replace(prosrc,'ANY((SELECT array_agg(w.id) FROM week_records w)::uuid[])','')))/length('ANY((SELECT array_agg(w.id) FROM week_records w)::uuid[])') FROM pg_proc WHERE oid='"+sig+"'::regprocedure")=='3'
 sql(candidate,'weekly_source_count_preimage_changed')
 print(json.dumps({'qualification':'passed','actual_original_and_changed_source_count_function':True,'independent_fault_and_boundary_cases':len(cases),'plan_modes':2,'identical_results':True,'exact_keyset_memberships':3,'owner_acl_volatility_search_path_preserved':True,'replay_refused':True,'cutoff_and_ghost_predicates_unchanged_identity_helpers_in_fixture':True,'postimage_md5':post,'production_payment':False}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(base)
