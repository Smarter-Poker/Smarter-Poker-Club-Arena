#!/usr/bin/env python3
"""Original whole-hand attribution bags/counts, exact index installer, no production access."""
import argparse,hashlib,json,os,shutil,socket,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);args=ap.parse_args()
assert __debug__;root=Path(__file__).resolve().parents[2];fx=root/'scripts/ci/fixtures/whole-hand-attribution-cover';args.scratch.mkdir(parents=True,exist_ok=True)
w=Path(tempfile.mkdtemp(prefix='whole-hand-cover-',dir=args.scratch));pg=args.pg_bin;started=False
with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
env={**os.environ,'TMPDIR':str(w)};cmd=[pg/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(port),'-U','postgres','-d','postgres']
def run(c,sql=None,check=True):
 r=subprocess.run(list(map(str,c)),input=sql,text=True,capture_output=True,env=env,timeout=120)
 if check:assert r.returncode==0,r.stdout+r.stderr
 return r
def q(sql):return run(cmd,sql).stdout.strip()
def fail(sql,msg):
 r=run(cmd,sql,False);assert r.returncode and msg in r.stderr,(msg,r.stdout,r.stderr)
def nodes(n):
 yield n
 for c in n.get('Plans',[]):yield from nodes(c)
try:
 assert ' 17.'in run([pg/'postgres','--version']).stdout
 run([pg/'initdb','-D',w/'d','-U','postgres','-A','trust','--no-locale']);run([pg/'pg_ctl','-D',w/'d','-l',w/'pg.log','-o',f'-h 127.0.0.1 -p {port} -k ""','-w','start']);started=True
 q((fx/'bootstrap.sql').read_text());q("INSERT INTO clubs VALUES('10000000-0000-0000-0000-000000000003',false,NULL);CREATE TABLE launch_cutoffs(club_id uuid PRIMARY KEY,starts_at timestamptz);CREATE OR REPLACE FUNCTION fn_ca_launch_accounting_start(text,uuid,timestamptz)RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT greatest($3,coalesce((SELECT starts_at FROM launch_cutoffs WHERE club_id=$2),$3))$$;")
 q((fx/'original.sql').read_text());sig='fn_rakeback_split_counts(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'
 meta="SELECT to_jsonb(p)FROM pg_proc p WHERE oid='"+sig+"'::regprocedure";before_meta=q(meta)
 # Exact original whole-hand projection: no club/player/positive-credit filter.
 query="SELECT a.id,a.rake_record_id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit FROM rake_attributions a WHERE a.rake_record_id=ANY($1::uuid[])"
 q('PREPARE original_attrs(uuid[]) AS '+query)
 clubs="ARRAY['10000000-0000-0000-0000-000000000001'::uuid,'10000000-0000-0000-0000-000000000002'::uuid,'10000000-0000-0000-0000-000000000003'::uuid]"
 def oracle(start="2026-10-12 07:00Z",end="2026-10-19 07:00Z",full=False):
  times="generate_series('"+start+"'::timestamptz,'"+end+"'::timestamptz-interval '1 microsecond',interval '2 hours')g"if full else"(SELECT '"+start+"'::timestamptz g)z"
  return"SELECT jsonb_agg(jsonb_build_array(c,g,fn_rakeback_split_counts(c,'"+start+"','"+end+"',g,least(g+interval '2 hours','"+end+"')))ORDER BY c,g)FROM unnest("+clubs+")c CROSS JOIN "+times
 def answers():
  out=[]
  for mode in ['force_custom_plan','force_generic_plan']:
   for name,change,_ in json.loads((fx/'cases.json').read_text()):
    out.append(q('BEGIN;SET LOCAL plan_cache_mode='+mode+';'+change+';'+oracle()+";SELECT coalesce(jsonb_agg(to_jsonb(a)ORDER BY id),'[]')FROM("+query.replace('$1',"ARRAY[(SELECT id FROM rake_records ORDER BY id LIMIT 1),md5('record-1')::uuid,NULL::uuid]")+')a;ROLLBACK;'))
  out.append(q(oracle(full=True)))
  for start,end in [('2026-10-26 07:00Z','2026-11-02 08:00Z'),('2026-03-02 08:00Z','2026-03-09 07:00Z')]:out.append(q(oracle(start,end,True)))
  return out
 baseline=answers();data="SELECT md5(jsonb_build_object('r',(SELECT jsonb_agg(to_jsonb(r)ORDER BY id)FROM rake_records r),'a',(SELECT jsonb_agg(to_jsonb(a)ORDER BY id)FROM rake_attributions a),'s',(SELECT jsonb_agg(to_jsonb(s)ORDER BY id)FROM accounting_cash_rake_sources s),'b',(SELECT jsonb_agg(to_jsonb(b)ORDER BY rake_record_id)FROM accounting_cash_accrual_batches b))::text)";before_data=q(data)
 migration=next((root/'supabase/migrations').glob('*_whole_hand_rakeback_reads_the_original_attribution_cover.sql')).read_text();pre,body=migration.split('BEGIN;',1);body='BEGIN;'+body
 q(pre);fail(body.replace('public.fn_platform_frozen()','true'),'whole_hand_cover_install_frozen')
 fail(body.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'forced_rollback';END$$;COMMIT;"),'forced_rollback');q(body)
 assert answers()==baseline;assert q(meta)==before_meta;assert q(data)==before_data;q(migration)
 fault=0
 for ddl in ["(rake_record_id)","(club_id) INCLUDE(id,hand_id,player_id,rake_record_id,weighted_rake_credit)","(rake_record_id) INCLUDE(id,hand_id,player_id,club_id,weighted_rake_credit) WHERE weighted_rake_credit>0","(rake_record_id DESC) INCLUDE(id,hand_id,player_id,club_id,weighted_rake_credit)","(rake_record_id) INCLUDE(id,player_id,hand_id,club_id,weighted_rake_credit)"]:
  q('DROP INDEX rake_attributions_whole_hand_cover;CREATE INDEX rake_attributions_whole_hand_cover ON rake_attributions '+ddl);fail(body,'whole_hand_cover_');fault+=1
 q('DROP INDEX rake_attributions_whole_hand_cover;');r=run(cmd,'CREATE UNIQUE INDEX CONCURRENTLY rake_attributions_whole_hand_cover ON rake_attributions(club_id);',False);assert r.returncode
 assert q("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='rake_attributions_whole_hand_cover'::regclass")=='t';fail(body,'whole_hand_cover_shape_changed');fault+=1
 q('DROP INDEX rake_attributions_whole_hand_cover;');q(pre);q(body)
 # Bag/null proof independent of the count owner, with actual nullable fields.
 q("INSERT INTO rake_attributions VALUES(md5('null-fields')::uuid,md5('record-1')::uuid,NULL,NULL,NULL,NULL),(md5('null-key')::uuid,NULL,NULL,NULL,NULL,-1);")
 variants=["NULL::uuid[]","ARRAY[]::uuid[]","ARRAY[NULL::uuid]","ARRAY[md5('record-1')::uuid,NULL::uuid,md5('record-1')::uuid]","ARRAY[md5('missing')::uuid]"]
 def bags():return[q("SELECT coalesce(jsonb_agg(to_jsonb(a)ORDER BY id),'[]')FROM("+query.replace('$1',v)+')a')for v in variants]
 bag_before=bags();q('DROP INDEX rake_attributions_whole_hand_cover;');assert bags()==bag_before;q(pre);q(body);assert bags()==bag_before
 # Use the middle of the new cohort, away from boundary pages dirtied by prior rollback faults.
 # Bounded representative natural plan: all clubs, wide unrelated heap payload.
 q("ALTER TABLE rake_attributions ADD COLUMN payload text;ALTER TABLE rake_attributions ALTER COLUMN payload SET STORAGE PLAIN;INSERT INTO rake_attributions SELECT md5('bulk-attr-'||g||'-'||c)::uuid,md5('bulk-record-'||g)::uuid,md5('bulk-hand-'||g)::uuid,md5('bulk-player-'||c)::uuid,md5('club-'||c)::uuid,CASE WHEN g%13=0 THEN NULL WHEN g%17=0 THEN -1 ELSE 1 END,repeat(md5(g::text),16)FROM generate_series(1,5000)g CROSS JOIN generate_series(1,3)c;VACUUM ANALYZE rake_attributions;")
 keys="ARRAY(SELECT md5('bulk-record-'||g)::uuid FROM generate_series(2001,2100)g)";selected=query.replace('$1',keys);bag="SELECT jsonb_agg(to_jsonb(a)ORDER BY id)FROM("+selected+')a';plan_query='EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+selected
 q('DROP INDEX rake_attributions_whole_hand_cover;');old_plan=json.loads(q(plan_query))[0];expected=q(bag);q(pre);q(body);q('VACUUM ANALYZE rake_attributions;');new_plan=json.loads(q(plan_query))[0];assert q(bag)==expected
 covered=[n for n in nodes(new_plan['Plan'])if n.get('Index Name')=='rake_attributions_whole_hand_cover'];assert covered and all(n['Node Type']=='Index Only Scan'and n['Heap Fetches']==0 for n in covered),new_plan
 assert any(n.get('Relation Name')=='rake_attributions'and n['Node Type']in['Index Scan','Bitmap Heap Scan','Seq Scan']for n in nodes(old_plan['Plan']))
 rid=q("SELECT id FROM rake_attributions WHERE rake_record_id=md5('bulk-record-2001')::uuid LIMIT 1");other=subprocess.Popen(list(map(str,cmd)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 other.stdin.write("BEGIN;UPDATE rake_attributions SET weighted_rake_credit=9 WHERE id='"+rid+"';SELECT 'updated';\n");other.stdin.flush();assert other.stdout.readline().strip()=='updated'
 try:
  mvcc=json.loads(q(plan_query))[0];assert q(bag)==expected;assert any(n.get('Index Name')=='rake_attributions_whole_hand_cover'and n.get('Heap Fetches',0)>0 for n in nodes(mvcc['Plan']))
 finally:other.stdin.write('ROLLBACK;\n');other.stdin.close();other.wait(timeout=10)
 q("UPDATE rake_attributions SET weighted_rake_credit=9 WHERE id='"+rid+"';");assert q(bag)!=expected;assert q(meta)==before_meta
 result={'passed':True,'whole_original_count_cases':len(baseline),'original_wholehand_projection_bags_equal':True,'null_empty_duplicate_input_bags':len(variants),'all_function_metadata_unchanged':True,'raw_source_fingerprints_unchanged_by_install':True,'frozen_rollback_replay':True,'catalog_fault_cases':fault,'actual_invalid_CCI_refused':True,'natural_index_only_zero_heap_fetches':True,'uncommitted_MVCC_heap_fallback':True,'committed_financial_field_update_visible':True,'native_before_ms':old_plan['Execution Time'],'native_after_ms':new_plan['Execution Time'],'limits':'Original counts/projection/index are real; launch/ghost/platform helpers controlled; no production timing or full4AM capacity claim.'}
 (args.scratch/'whole-hand-attribution-cover-result.json').write_text(json.dumps(result,indent=2));(args.scratch/'whole-hand-attribution-cover-plans.json').write_text(json.dumps({'before':old_plan,'after':new_plan,'mvcc':mvcc},indent=2));print(json.dumps(result))
finally:
 if started:run([pg/'pg_ctl','-D',w/'d','-m','immediate','-w','stop'],check=False)
 shutil.rmtree(w,ignore_errors=True)
