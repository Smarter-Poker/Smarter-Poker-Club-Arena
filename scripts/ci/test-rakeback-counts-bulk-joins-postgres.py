#!/usr/bin/env python3
"""Execute current native counts and indexed incomplete joins on isolated PG17, never production."""
import argparse,json,os,re,shutil,socket,subprocess,tempfile
from pathlib import Path
import hashlib
HERE=Path(__file__).resolve().parent
FX=HERE/'fixtures/rakeback-counts-bulk-joins'
if not __debug__:raise RuntimeError('optimized qualification is refused')
ap=argparse.ArgumentParser();ap.add_argument('--migration',type=Path,default=HERE.parents[1]/'supabase/migrations/20261027015808_rakeback_source_windows_read_each_keyset_once.sql');ap.add_argument('--output',type=Path);ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True)
a=ap.parse_args();root=HERE.parents[1]
base=Path(tempfile.mkdtemp(prefix='rd-',dir=a.scratch));data=base/'d';started=False
with socket.socket() as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['TMPDIR']=str(base)
def run(args,content=None,error=None):
 p=subprocess.run([str(x) for x in args],input=content,text=True,capture_output=True,env=env,timeout=90)
 if error:assert p.returncode and error in p.stderr,p.stdout+p.stderr
 else:assert p.returncode==0,p.stdout+p.stderr
 return p.stdout.strip()
def sql(s,error=None):return run([a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],s,error)
try:
 assert ' 17.' in run([a.pg_bin/'postgres','--version']),'PostgreSQL17 required'
 run([a.pg_bin/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([a.pg_bin/'pg_ctl','-D',data,'-l',base/'log','-o',f'-h 127.0.0.1 -k {base} -p {port}','-w','start']);started=True
 sql("""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE TABLE clubs(id uuid PRIMARY KEY,is_union boolean,union_id uuid);
 CREATE TABLE rake_records(id uuid PRIMARY KEY,hand_id uuid,club_id uuid,rake_amount numeric,created_at timestamptz,is_tournament boolean,tournament_id uuid,table_id uuid,metadata jsonb);
 CREATE TABLE rake_attributions(id uuid PRIMARY KEY,rake_record_id uuid,hand_id uuid,player_id uuid,club_id uuid,weighted_rake_credit numeric);
 CREATE INDEX attr_record ON rake_attributions(rake_record_id);
 CREATE TABLE accounting_cash_accrual_batches(rake_record_id uuid PRIMARY KEY,status text);
 CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY,rake_record_id uuid,player_id uuid,club_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb,union_id uuid,coordinator_union_id uuid);
 CREATE UNIQUE INDEX source_record ON accounting_cash_rake_sources(rake_record_id,player_id);
 CREATE INDEX source_period ON accounting_cash_rake_sources(club_id,earned_at);
 CREATE INDEX record_created ON rake_records(created_at);
 CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
 CREATE FUNCTION fn_ca_launch_accounting_start(text,uuid,timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT $3$$;
 CREATE FUNCTION fn_rake_record_is_ghost_twin(uuid,uuid,jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT false$$;
 INSERT INTO clubs VALUES('10000000-0000-0000-0000-000000000001',false,NULL),('10000000-0000-0000-0000-000000000002',false,NULL);
 INSERT INTO rake_records SELECT md5('record-'||g)::uuid,md5('hand-'||g)::uuid,'10000000-0000-0000-0000-000000000001',1,'2026-10-12 08:00Z',false,NULL,NULL,'{}' FROM generate_series(1,3)g;
 INSERT INTO rake_records SELECT md5('filler-'||g)::uuid,md5('fh-'||g)::uuid,'10000000-0000-0000-0000-000000000002',1,'2026-09-01',false,NULL,NULL,'{}' FROM generate_series(1,6000)g;
 INSERT INTO rake_attributions SELECT md5('attr-'||id)::uuid,id,hand_id,md5('player-'||id)::uuid,club_id,1 FROM rake_records;
 INSERT INTO accounting_cash_accrual_batches SELECT id,'accrued' FROM rake_records;
 INSERT INTO accounting_cash_rake_sources SELECT md5('src-'||r.id)::uuid,r.id,a.player_id,a.club_id,r.created_at,1,jsonb_build_object('attribution_id',a.id,'player_id',a.player_id,'club_id',a.club_id,'union_id',NULL,'coordinator_union_id',NULL),NULL,NULL FROM rake_records r JOIN rake_attributions a ON a.rake_record_id=r.id;
 ANALYZE;""")
 receipt=json.loads((FX/'replacement.json').read_text())
 pre={'definition':(FX/'original.sql').read_text(),'md5':receipt['original_full_md5']}
 assert hashlib.md5(pre['definition'].encode()).hexdigest()==pre['md5'],'captured original source changed'
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
 cases.extend([
 ('duplicate_attribution',"INSERT INTO rake_attributions SELECT md5('duplicate-attribution')::uuid,rake_record_id,hand_id,player_id,club_id,weighted_rake_credit FROM rake_attributions WHERE rake_record_id="+rid,(1,1,0)),
 ('null_player',"UPDATE rake_attributions SET player_id=NULL WHERE rake_record_id="+rid,(1,1,1)),
 ('wrong_source_club',"UPDATE accounting_cash_rake_sources SET club_id='10000000-0000-0000-0000-000000000002' WHERE rake_record_id="+rid,(0,1,0)),
 ('source_before_full_week',"UPDATE accounting_cash_rake_sources SET earned_at='2026-10-11 08:00Z' WHERE rake_record_id="+rid,(0,1,0)),
 ('source_elsewhere_in_full_week',"UPDATE accounting_cash_rake_sources SET earned_at='2026-10-12 10:00Z' WHERE rake_record_id="+rid,(0,1,0)),
 # Relax only the isolated source uniqueness prerequisite to verify the query
 # preserves bag multiplicity too; production always keeps its unique index.
 ('relaxed_duplicate_bad_source',"DROP INDEX source_record;INSERT INTO accounting_cash_rake_sources SELECT md5('duplicate-source')::uuid,rake_record_id,player_id,club_id,earned_at,rake_credit,jsonb_set(contract,'{club_id}',to_jsonb('wrong'::text)),union_id,coordinator_union_id FROM accounting_cash_rake_sources WHERE rake_record_id="+rid,(0,1,0))
 ])
 duplicate="INSERT INTO accounting_cash_rake_sources SELECT md5('unique-refused')::uuid,rake_record_id,player_id,club_id,earned_at,rake_credit,contract,union_id,coordinator_union_id FROM accounting_cash_rake_sources WHERE rake_record_id="+rid
 sql(duplicate,'duplicate key value violates unique constraint')
 old=verify()
 assert pre['definition'].count(receipt['old'])==1,'exact original query shape changed'
 candidate=pre['definition'].replace(receipt['old'],receipt['new'],1)
 assert hashlib.md5(candidate.encode()).hexdigest()==receipt['candidate_full_md5'],'candidate source changed'
 if a.migration:
  installer=a.migration.read_text();body=installer.replace('BEGIN;','',1).rsplit('COMMIT;',1)[0]
  sql('BEGIN;REVOKE EXECUTE ON FUNCTION '+sig+' FROM service_role;'+body,'weekly_count_bulk_join_metadata_changed')
  sql("BEGIN;CREATE OR REPLACE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;"+body,'weekly_count_bulk_installation_frozen')
  sql(installer.rsplit('COMMIT;',1)[0]+'ROLLBACK;')
  assert sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")==pre['md5']
  sql(installer)
  sql(installer,'weekly_count_bulk_join_preimage_changed')
 else: sql(candidate)
 assert verify()==old
 assert sql(meta)==before_meta
 post=sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")
 # Create an independent large keyset and inspect the actual complete original
 # query and candidate plans. All malformed cases above compare all three counts.
 sql("""INSERT INTO rake_records SELECT md5('load-record-'||g)::uuid,md5('load-hand-'||g)::uuid,'10000000-0000-0000-0000-000000000001',1,'2026-10-12 08:00Z',false,NULL,NULL,'{}' FROM generate_series(1,12000)g;
 INSERT INTO rake_attributions SELECT md5('attr-'||r.id)::uuid,r.id,r.hand_id,md5('player-'||r.id)::uuid,r.club_id,1 FROM rake_records r WHERE NOT EXISTS(SELECT FROM rake_attributions a WHERE a.rake_record_id=r.id);
 INSERT INTO accounting_cash_accrual_batches SELECT r.id,'accrued' FROM rake_records r WHERE NOT EXISTS(SELECT FROM accounting_cash_accrual_batches b WHERE b.rake_record_id=r.id);
 INSERT INTO accounting_cash_rake_sources SELECT md5('src-'||r.id)::uuid,r.id,a.player_id,a.club_id,r.created_at,1,jsonb_build_object('attribution_id',a.id,'player_id',a.player_id,'club_id',a.club_id,'union_id',NULL,'coordinator_union_id',NULL),NULL,NULL FROM rake_records r JOIN rake_attributions a ON a.rake_record_id=r.id WHERE NOT EXISTS(SELECT FROM accounting_cash_rake_sources s WHERE s.rake_record_id=r.id);ANALYZE;""")
 def query(definition):
  q=definition[definition.index(' WITH week_records'):definition.index(' RETURN jsonb_build_object')].replace(' INTO evidence_issues,incomplete_issues,drifted_issues','')
  for k,v in [('p_club_id',"'10000000-0000-0000-0000-000000000001'::uuid"),('scope_union','NULL::uuid'),('v_from',"'2026-10-12 07:00Z'::timestamptz"),('v_to',"'2026-10-19 07:00Z'::timestamptz"),('w_from',"'2026-10-12 07:00Z'::timestamptz"),('w_to',"'2026-10-12 09:00Z'::timestamptz")]:q=re.sub(r'\b'+k+r'\b',v,q)
  return q
 plans={}
 for name,d in [('original',pre['definition']),('candidate',candidate)]:
  plans[name]=json.loads(sql('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON,TIMING FALSE)'+query(d)))[0]
  assert json.loads(sql(call.replace('fn_rakeback_split_counts','fn_rakeback_split_counts')))=={'evidence':0,'incomplete':0,'drifted':0}
 nodes=[]
 def walk(n):
  nodes.append(n)
  for c in n.get('Plans',[]):walk(c)
 walk(plans['candidate']['Plan'])
 full=[n for n in nodes if n.get('Join Type')=='Full']
 assert len(full)==2 and all(n['Node Type'] in ['Hash Join','Merge Join'] for n in full),full
 assert not any(n.get('CTE Name') in ['week_sources','week_batches'] and n.get('Actual Loops',0)>1 for n in nodes)
 out={'qualification':'passed','original_md5':pre['md5'],'postimage_md5':post,'faults':len(cases),'plan_modes':2,'all_three_counts_identical':True,'metadata_preserved':True,'installer_rollback_replay_acl_freeze':bool(a.migration),'full_join_nodes':len(full),'timings_ms':{k:v['Execution Time'] for k,v in plans.items()},'production_payment':False,'limits':'Controlled schema and cutoff/ghost helpers; actual unchanged source-evidence owner body and full query executed.'}
 out['migration_sha256']=hashlib.sha256(a.migration.read_bytes()).hexdigest()
 output=a.output or a.scratch/'rakeback-counts-keyset-result.json'
 output.write_text(json.dumps(out,indent=2)+'\n')
 output.with_suffix('.plans.json').write_text(json.dumps(plans,indent=2)+'\n')
 print(json.dumps(out))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(base)
