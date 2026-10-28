import json,os,subprocess,socket,tempfile,shutil,time,hashlib,sys,argparse
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',required=True,type=Path);ap.add_argument('--scratch-root',required=True,type=Path);ap.add_argument('--migration',type=Path);args=ap.parse_args()
repo=Path(__file__).resolve().parents[2];fixtures=repo/'scripts/ci/fixtures/original-week-clubs';base=Path(tempfile.mkdtemp(prefix='original-week-clubs-cover-',dir=args.scratch_root));candidate_name='original.sql'
shutil.copyfile(fixtures/'original.sql',base/'original.sql')
pg=args.pg_bin;d=Path(tempfile.mkdtemp(prefix='pg-',dir=base));started=False
with socket.socket() as x:x.bind(('127.0.0.1',0));port=str(x.getsockname()[1])
def run(args,s=None):
 p=subprocess.run(list(map(str,args)),input=s,text=True,capture_output=True,timeout=90,env={**os.environ,'TMPDIR':str(d)})
 assert p.returncode==0,p.stdout+p.stderr
 return p.stdout.strip()
def sql(s):return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],s)
U='10000000-0000-0000-0000-000000000001';C='20000000-0000-0000-0000-000000000001'
try:
 run([pg/'initdb','-D',d/'data','-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);run([pg/'pg_ctl','-D',d/'data','-l',d/'log','-o',f'-h 127.0.0.1 -k \'\' -p {port}','-w','start']);started=True
 sql('''CREATE TABLE clubs(id uuid PRIMARY KEY,is_union boolean);
 CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY,club_id uuid,coordinator_union_id uuid,earned_at timestamptz);
 CREATE INDEX cash_scope ON accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at);
 CREATE TABLE accounting_tournament_fee_sources(id uuid PRIMARY KEY,club_id uuid,coordinator_union_id uuid,tournament_id uuid,charged_at timestamptz,rake_credit numeric,union_id uuid);
 CREATE INDEX tour_scope ON accounting_tournament_fee_sources(coordinator_union_id,club_id) WHERE coordinator_union_id IS NOT NULL;
 CREATE INDEX tour_club_event ON accounting_tournament_fee_sources(club_id,tournament_id);
 CREATE INDEX tour_coord_event ON accounting_tournament_fee_sources(coordinator_union_id,tournament_id) WHERE coordinator_union_id IS NOT NULL;
 CREATE INDEX tour_tournament ON accounting_tournament_fee_sources(tournament_id);
 CREATE TABLE accounting_tournament_recognized_sources(source_id uuid,tournament_id uuid,recognized_at timestamptz,rake_credit numeric,disposition text);
 CREATE UNIQUE INDEX recognized_source ON accounting_tournament_recognized_sources(source_id);
 CREATE INDEX recognized_event ON accounting_tournament_recognized_sources(tournament_id) INCLUDE(source_id,recognized_at,disposition,rake_credit);
 CREATE INDEX recognized_time ON accounting_tournament_recognized_sources(recognized_at,tournament_id);
 CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid,recognized_at timestamptz,status text,union_id uuid);
 CREATE INDEX recognition_time ON accounting_tournament_fee_recognitions(recognized_at) INCLUDE(tournament_id);
 CREATE UNIQUE INDEX recognition_tournament ON accounting_tournament_fee_recognitions(tournament_id);
 CREATE TABLE accounting_agreement_history(id bigint,entity_key text,entity_type text,observed_at timestamptz,after_terms jsonb);
 CREATE TABLE accounting_rakeback_period_calculations(club_id uuid,coordinator_union_id uuid,period_start date,period_end date);
 CREATE TABLE settlement_periods(club_id uuid,union_id uuid,start_at timestamptz,end_at timestamptz);
 CREATE TABLE cutoffs(club_id uuid PRIMARY KEY,at timestamptz);
 CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.engine',true),'on')='on' $$;
 CREATE FUNCTION fn_ca_launch_accounting_cutoff(text,uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT at FROM cutoffs WHERE club_id=$2 $$;''')
 old=(base/'original.sql').read_text().replace('FUNCTION public.fn_accounting_week_clubs(', 'FUNCTION public.test_old(')
 new=(base/candidate_name).read_text().replace('FUNCTION public.fn_accounting_week_clubs(', 'FUNCTION public.test_new(')
 sql(old);sql(new)
 sql((base/'original.sql').read_text())
 signature='public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'
 old_md5=sql("SELECT md5(pg_get_functiondef('"+signature+"'::regprocedure))")
 assert old_md5=='e5ec460a159bfb46735d99be1a0738a3',old_md5
 sql('REVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC')
 metadata_query="SELECT jsonb_build_array(proowner,proacl,proconfig,provolatile,prosecdef,proparallel,proisstrict,proretset) FROM pg_proc WHERE oid='"+signature+"'::regprocedure"
 old_metadata=sql(metadata_query)
 sql((base/candidate_name).read_text())
 assert sql(metadata_query)==old_metadata
 new_md5=sql("SELECT md5(pg_get_functiondef('"+signature+"'::regprocedure))")
 (base/(candidate_name+'.owner-identities.json')).write_text(json.dumps({'preimage_md5':old_md5,'postimage_md5':new_md5,'metadata_unchanged':True},indent=2)+'\n')
 sql(f"INSERT INTO clubs VALUES('{C}',false),('{U}',true)")
 seed=f'''INSERT INTO accounting_tournament_fee_sources VALUES(md5('s')::uuid,'{C}','{U}',md5('t')::uuid,'2026-09-21 08:00Z',5,NULL);
 INSERT INTO accounting_tournament_recognized_sources VALUES(md5('s')::uuid,md5('t')::uuid,'2026-09-22 08:00Z',5,'earned');
 INSERT INTO accounting_tournament_fee_recognitions VALUES(md5('t')::uuid,'2026-09-22 08:00Z','recognized',NULL);'''
 sql(seed)
 cases=[('earned_old','',[C]),('missing_recognition','DELETE FROM accounting_tournament_fee_recognitions',[]),('missing_recognized_source','DELETE FROM accounting_tournament_recognized_sources',[]),('wrong_recognition_status',"UPDATE accounting_tournament_fee_recognitions SET status='pending'",[]),('wrong_disposition',"UPDATE accounting_tournament_recognized_sources SET disposition='cancelled'",[]),('amount_mismatch','UPDATE accounting_tournament_recognized_sources SET rake_credit=6',[]),('null_amount','UPDATE accounting_tournament_recognized_sources SET rake_credit=NULL',[]),('wrong_union',f"UPDATE accounting_tournament_fee_recognitions SET union_id='{U}'",[]),('matching_union',f"UPDATE accounting_tournament_fee_recognitions SET union_id='{U}';UPDATE accounting_tournament_fee_sources SET union_id='{U}'",[C]),('recognition_time_mismatch',"UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-09-23 08:00Z'",[]),('foreign_source_scope',f"UPDATE accounting_tournament_fee_sources SET coordinator_union_id='{C}'",[]),('missing_source','DELETE FROM accounting_tournament_fee_sources',[]),('wrong_tournament',"UPDATE accounting_tournament_recognized_sources SET tournament_id=md5('wrong')::uuid",[]),('duplicate_witness',"INSERT INTO accounting_tournament_recognized_sources SELECT * FROM accounting_tournament_recognized_sources",[C]),('duplicate_recognition',"INSERT INTO accounting_tournament_fee_recognitions SELECT * FROM accounting_tournament_fee_recognitions",[C]),('cutoff_after_charge',f"INSERT INTO cutoffs VALUES('{C}','2026-09-22')",[]),('cutoff_before_charge',f"INSERT INTO cutoffs VALUES('{C}','2026-09-21')",[C]),('null_charge_no_cutoff','UPDATE accounting_tournament_fee_sources SET charged_at=NULL',[C]),('null_charge_cutoff',f"UPDATE accounting_tournament_fee_sources SET charged_at=NULL;INSERT INTO cutoffs VALUES('{C}','2026-09-21')",[]),('infinite_charge_cutoff',f"UPDATE accounting_tournament_fee_sources SET charged_at='infinity';INSERT INTO cutoffs VALUES('{C}','2026-09-21')",[]),('infinite_charge_no_cutoff',"UPDATE accounting_tournament_fee_sources SET charged_at='infinity'",[C]),('outside_period',"UPDATE accounting_tournament_recognized_sources SET recognized_at='2026-09-28 07:00Z';UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-09-28 07:00Z'",[]),('left_boundary',"UPDATE accounting_tournament_recognized_sources SET recognized_at='2026-09-21 07:00Z';UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-09-21 07:00Z'",[C]),('cash_accepts_even_bad_tournament',f"INSERT INTO accounting_cash_rake_sources VALUES(md5('cash')::uuid,'{C}','{U}','2026-09-22');DELETE FROM accounting_tournament_fee_recognitions",[C]),('calculation_only',f"DELETE FROM accounting_tournament_fee_recognitions;INSERT INTO accounting_rakeback_period_calculations VALUES('{C}','{U}','2026-09-21','2026-09-27')",[C]),('settlement_only',f"DELETE FROM accounting_tournament_fee_recognitions;INSERT INTO settlement_periods VALUES('{C}','{U}','2026-09-21 07:00Z','2026-09-28 07:00Z')",[C]),('history_only',f"DELETE FROM accounting_tournament_fee_recognitions;INSERT INTO accounting_agreement_history VALUES(1,'a','union_clubs','2026-09-20',jsonb_build_object('club_id','{C}','union_id','{U}'))",[C])]
 cases.extend([
 ('recognition_before_cutoff',f"UPDATE accounting_tournament_fee_sources SET charged_at='2026-09-24';INSERT INTO cutoffs VALUES('{C}','2026-09-23')",[]),
 ('explicit_null_cutoff',f"INSERT INTO cutoffs VALUES('{C}',NULL)",[C]),
 ('null_recognition_time','UPDATE accounting_tournament_recognized_sources SET recognized_at=NULL;UPDATE accounting_tournament_fee_recognitions SET recognized_at=NULL',[]),
 ('null_source_club','UPDATE accounting_tournament_fee_sources SET club_id=NULL',[]),
 ('null_source_credit','UPDATE accounting_tournament_fee_sources SET rake_credit=NULL',[]),
 ('nonfinite_recognition',"UPDATE accounting_tournament_recognized_sources SET recognized_at='infinity';UPDATE accounting_tournament_fee_recognitions SET recognized_at='infinity'",[]),
 ('zero_cutoff_current_witness',f"INSERT INTO cutoffs VALUES('{C}','2026-09-22 08:00Z');UPDATE accounting_tournament_fee_sources SET charged_at='2026-09-22 08:00Z'",[C])
 ])
 original_bytes=(base/'original.sql').read_text();candidate_bytes=(base/candidate_name).read_text()
 assert original_bytes==candidate_bytes
 cases.extend([
 ('self_union_source_final_empty',f"UPDATE accounting_tournament_fee_sources SET club_id='{U}'",[]),
 ('mixed_self_union_and_real_club',f"INSERT INTO accounting_tournament_fee_sources SELECT md5('self-source')::uuid,'{U}',coordinator_union_id,md5('self-tournament')::uuid,charged_at,rake_credit,union_id FROM accounting_tournament_fee_sources;INSERT INTO accounting_tournament_recognized_sources VALUES(md5('self-source')::uuid,md5('self-tournament')::uuid,'2026-09-22 08:00Z',5,'earned');INSERT INTO accounting_tournament_fee_recognitions VALUES(md5('self-tournament')::uuid,'2026-09-22 08:00Z','recognized',NULL)",[C]),
 ('self_union_does_not_rescue_bad_real_club',f"INSERT INTO accounting_tournament_fee_sources SELECT md5('self-source')::uuid,'{U}',coordinator_union_id,md5('self-tournament')::uuid,charged_at,rake_credit,union_id FROM accounting_tournament_fee_sources;INSERT INTO accounting_tournament_recognized_sources VALUES(md5('self-source')::uuid,md5('self-tournament')::uuid,'2026-09-22 08:00Z',5,'earned');INSERT INTO accounting_tournament_fee_recognitions VALUES(md5('self-tournament')::uuid,'2026-09-22 08:00Z','recognized',NULL);DELETE FROM accounting_tournament_fee_recognitions WHERE tournament_id=md5('t')::uuid",[])
 ])
 def verify_cases():
  results=[]
  for mode in ['force_generic_plan','force_custom_plan']:
   for name,change,expected in cases:
    if name in ['duplicate_witness','duplicate_recognition']: continue
    q=f"SELECT coalesce(jsonb_agg(club_id ORDER BY club_id),'[]'::jsonb) FROM public.{{fn}}('{U}',NULL,'2026-09-21 07:00Z','2026-09-28 07:00Z')"
    out=sql('BEGIN;SET LOCAL plan_cache_mode='+mode+';'+change+(';' if change else '')+q.format(fn='test_old')+';'+q.format(fn='test_new')+';ROLLBACK;').splitlines()
    assert json.loads(out[0])==expected and out[0]==out[1],(name,out,expected)
    results.append([mode,name,expected])
  # Exact current-week and DST periods with genuine source and recognition witnesses.
  for label,lo,hi in [('current','2026-10-19 07:00Z','2026-10-26 07:00Z'),('DST169','2026-10-26 07:00Z','2026-11-02 08:00Z')]:
   for fn in ['test_old','test_new']:
    out=sql(f"BEGIN;UPDATE accounting_tournament_fee_sources SET charged_at='{lo}';UPDATE accounting_tournament_recognized_sources SET recognized_at='{lo}';UPDATE accounting_tournament_fee_recognitions SET recognized_at='{lo}';SELECT coalesce(jsonb_agg(club_id ORDER BY club_id),'[]'::jsonb) FROM {fn}('{U}',NULL,'{lo}','{hi}');ROLLBACK;")
    assert json.loads(out)==[C],(label,fn,out)
   results.append([label,'exact_source_witness',[C]])
  return results
 # Exercise every original semantic oracle before and after the exact CCI route.
 before=verify_cases()
 migration=args.migration or repo/'supabase/migrations/20261027151555_original_week_clubs_cover_the_coordinator_club_and_event.sql'
 splitter="import {splitConcurrentPreamble} from "+json.dumps((repo/'scripts/ci/migration-concurrent-preamble.mjs').as_uri())+";import fs from 'node:fs';console.log(JSON.stringify(splitConcurrentPreamble(fs.readFileSync(process.argv[1],'utf8'))));"
 pieces=json.loads(run(['node','--input-type=module','-e',splitter,migration]));assert pieces['ok'] and len(pieces['indexes'])==1,pieces
 ix='accounting_tournament_week_club_event_cover';body=pieces['body'];statement=pieces['indexes'][0]['statement']
 def install():sql(statement);sql(body)
 def refuses(content,expected):
  proc=subprocess.run([str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],input=content,text=True,capture_output=True,timeout=30)
  assert proc.returncode and expected in proc.stderr,proc.stdout+proc.stderr
 fingerprint_query="SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM accounting_tournament_fee_sources s),(SELECT jsonb_agg(to_jsonb(s) ORDER BY source_id) FROM accounting_tournament_recognized_sources s),(SELECT jsonb_agg(to_jsonb(s) ORDER BY tournament_id) FROM accounting_tournament_fee_recognitions s))::text)"
 fingerprint=sql(fingerprint_query);install();after=verify_cases();assert before==after
 assert sql(fingerprint_query)==fingerprint and sql(metadata_query)==old_metadata
 assert sql("SELECT md5(pg_get_functiondef('"+signature+"'::regprocedure))")==old_md5
 install();sql(body.replace('COMMIT;','ROLLBACK;'))
 # Representative whole original query, including the empty-club witness path.
 sql('''TRUNCATE accounting_tournament_fee_sources,accounting_tournament_recognized_sources,accounting_tournament_fee_recognitions;
 INSERT INTO accounting_tournament_fee_sources SELECT md5('s'||g)::uuid,md5('club'||(g%8))::uuid,'10000000-0000-0000-0000-000000000001',md5('t'||g)::uuid,'2026-09-22',1,NULL FROM generate_series(1,5000)g;
 INSERT INTO accounting_tournament_recognized_sources SELECT id,tournament_id,'2026-09-22',1,'cancelled' FROM accounting_tournament_fee_sources;
 INSERT INTO accounting_tournament_fee_recognitions SELECT tournament_id,'2026-09-22','recognized',NULL FROM accounting_tournament_fee_sources;''')
 original=(base/'original.sql').read_text();start=original.index('SELECT COALESCE(array_agg(w.id ORDER BY w.id)');end=original.index(') w;',start)+4
 query=original[start:end].replace(' INTO v_clubs','').replace('p_union_id',"'"+U+"'::uuid").replace('p_from',"'2026-09-21 07:00Z'::timestamptz").replace('p_to',"'2026-09-28 07:00Z'::timestamptz")
 plans={};timings={}
 def nodes(n):
  yield n
  for child in n.get('Plans',[]):yield from nodes(child)
 for cohort in ['zero_eligible','positive_mixed']:
  if cohort=='positive_mixed':sql("UPDATE accounting_tournament_recognized_sources SET disposition='earned';UPDATE accounting_tournament_fee_recognitions r SET status='pending' FROM accounting_tournament_fee_sources s WHERE s.tournament_id=r.tournament_id AND s.club_id=md5('club0')::uuid")
  sql('DROP INDEX '+ix);sql('VACUUM ANALYZE accounting_tournament_fee_sources;VACUUM ANALYZE accounting_tournament_recognized_sources;VACUUM ANALYZE accounting_tournament_fee_recognitions')
  fp=sql(fingerprint_query);prior=sql(query);old_plan=json.loads(sql('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query))
  install();following=sql(query);new_plan=json.loads(sql('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query))
  assert following==prior and sql(fingerprint_query)==fp
  assert sql(metadata_query)==old_metadata and sql("SELECT md5(pg_get_functiondef('"+signature+"'::regprocedure))")==old_md5
  matches=[n for n in nodes(new_plan[0]['Plan']) if n.get('Index Name')==ix and n['Node Type']=='Index Only Scan']
  assert matches and all(n.get('Heap Fetches')==0 for n in matches),matches
  assert any(all(k in n.get('Index Cond','') for k in ['coordinator_union_id','club_id','tournament_id']) and n.get('Actual Loops',0)>0 for n in matches),matches
  plans[cohort]={'before':old_plan,'after':new_plan};timings[cohort]={'before_ms':old_plan[0]['Execution Time'],'after_ms':new_plan[0]['Execution Time'],'ordered_result':([] if following=='{}' else following.strip('{}').split(',')),'cover_index_only_nodes':len(matches),'source_fingerprint_unchanged':True}
 # An updated tuple must be read through heap visibility, not stale INCLUDE data.
 point=f"SELECT id,club_id,tournament_id,charged_at,rake_credit,union_id FROM accounting_tournament_fee_sources WHERE coordinator_union_id='{U}' AND club_id=md5('club1')::uuid AND tournament_id=md5('t1')::uuid"
 mvcc=sql("BEGIN;UPDATE accounting_tournament_fee_sources SET rake_credit=99 WHERE id=md5('s1')::uuid;SELECT rake_credit FROM ("+point+") p;EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) "+point+";ROLLBACK;")
 first,plan=mvcc.split('\n',1);assert first=='99'
 mvcc_plan=json.loads(plan);assert any(n.get('Index Name')==ix and n.get('Heap Fetches',0)>0 for n in nodes(mvcc_plan[0]['Plan'])),mvcc_plan
 assert sql(fingerprint_query)==fp
 # Same-name wrong and genuinely INVALID indexes are refused, never repaired.
 wrong=[('wrong_keys','(club_id,coordinator_union_id,tournament_id) INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NOT NULL'),('wrong_include','(coordinator_union_id,club_id,tournament_id) INCLUDE(id,charged_at,union_id,rake_credit) WHERE coordinator_union_id IS NOT NULL'),('missing_include','(coordinator_union_id,club_id,tournament_id) INCLUDE(id,charged_at,rake_credit) WHERE coordinator_union_id IS NOT NULL'),('wrong_predicate','(coordinator_union_id,club_id,tournament_id) INCLUDE(id,charged_at,rake_credit,union_id)'),('wrong_order','(coordinator_union_id DESC,club_id,tournament_id) INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NOT NULL'),('unique','UNIQUE (coordinator_union_id,club_id,tournament_id) INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NOT NULL')]
 negative=[]
 for name,shape in wrong:
  sql('DROP INDEX '+ix)
  unique=shape.startswith('UNIQUE ');shape=shape.removeprefix('UNIQUE ')
  sql('CREATE '+('UNIQUE ' if unique else '')+'INDEX '+ix+' ON accounting_tournament_fee_sources '+shape)
  sql(statement);refuses(body,'week_club_event_cover_');negative.append(name)
 sql('DROP INDEX '+ix);refuses(body,'week_club_event_cover_missing');negative.append('missing')
 refuses('CREATE UNIQUE INDEX CONCURRENTLY '+ix+' ON accounting_tournament_fee_sources(coordinator_union_id)','could not create unique index')
 assert sql("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='"+ix+"'::regclass")=='t'
 sql(statement);refuses(body,'week_club_event_cover_shape_changed');negative.append('actual_invalid_concurrent_build')
 sql('DROP INDEX '+ix);install();install()
 assert sql(metadata_query)==old_metadata
 result={'semantic_cases_before_after':len(before),'case_results':before,'installer_cases':['apply','replay','body_rollback']+negative,'whole_owner_md5_unchanged':old_md5,'metadata_unchanged':True,'source_fingerprints_unchanged':True,'mvcc_heap_fallback':True,'plans':timings,'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'limit':'Actual unchanged original whole owner; isolated auth/cutoff boundary controlled. Original query naturally uses new covering index with all3keys and zero heap fetches. Native timing is not live timing or a whole-payout capacity certificate.'}
 (base/'result.json').write_text(json.dumps(result,indent=2)+'\n');(base/'plans.json').write_text(json.dumps(plans,indent=2)+'\n');print(json.dumps({**{k:v for k,v in result.items() if k!='case_results'},'evidence_directory':str(base)}))

finally:
 if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(d/'data'),'-m','immediate','-w','stop'],capture_output=True)
 shutil.rmtree(d)
