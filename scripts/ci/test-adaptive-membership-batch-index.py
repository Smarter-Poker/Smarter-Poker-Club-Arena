#!/usr/bin/env python3
"""Qualify all three exact retirement indexes on disposable PostgreSQL17."""
import argparse,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
assert a.scratch.is_dir() and not a.output.exists()
PG=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
migration=ROOT/'supabase/migrations/20261020144358_adaptive_membership_batch_cover.sql';raw=migration.read_bytes();text=raw.decode();boundary=text.index('BEGIN;');preamble=text[:boundary];body=text[boundary:]
root=Path(tempfile.mkdtemp(prefix='amb-',dir=a.scratch));started=False
assert len(str(root).encode())<85,'use a short SSD scratch path for the Unix socket'
psql=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',root,'-U','postgres','-d','postgres']
def run(args):return subprocess.run([str(x)for x in args],check=True,capture_output=True,text=True,timeout=120)
def q(sql):return run(psql+['-c',sql]).stdout.strip()
def walk(plan):
 yield plan
 for child in plan.get('Plans',[]):yield from walk(child)
try:
 run([PG/'initdb','-D',root/'d','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8']);run([PG/'pg_ctl','-D',root/'d','-l',root/'log','-o',"-k "+str(root)+" -c listen_addresses=''",'-w','start']);started=True
 q("CREATE SCHEMA smarter_private;CREATE TABLE smarter_private.horse_adaptive_batch_hand_membership(hand_digest text,batch_key text,PRIMARY KEY(hand_digest,batch_key));INSERT INTO smarter_private.horse_adaptive_batch_hand_membership SELECT lpad(md5(n::text),64,'0'),lpad((n%1000)::text,4,'0') FROM generate_series(1,30000)n")
 # Use the maintained installer splitter, not a second production DDL route.
 module=(ROOT/'scripts/ci/migration-concurrent-preamble.mjs').as_uri()
 code="import{readFileSync}from'node:fs';import{splitConcurrentPreamble}from'"+module+"';const s=splitConcurrentPreamble(readFileSync(process.argv[1],'utf8'));if(!s.ok||s.indexes.length!==1)throw Error('shape');console.log(JSON.stringify(s));"
 shape=json.loads(run(['node','--input-type=module','-e',code,migration]).stdout);assert shape['body']==body
 q(shape['indexes'][0]['statement']);q(body);q('VACUUM ANALYZE smarter_private.horse_adaptive_batch_hand_membership')
 assert q("SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='smarter_private.horse_adaptive_membership_batch_cover'::regclass")=='t'
 # Compare the old EXISTS with a complete batch-prefix membership stream.
 exact="""WITH tuples(ord,hand_digest,batch_key)AS(VALUES
 (1,lpad(md5('1'),64,'0'),'0001'),(2,lpad(md5('1'),64,'0'),'0001'),
 (3,lpad(md5('1'),64,'0'),'0002'),(4,NULL::text,'0001'),
 (5,'malformed-text','0001'),(6,lpad(md5('2'),64,'0'),'0002')),
 matches AS MATERIALIZED(SELECT hand_digest,batch_key FROM smarter_private.horse_adaptive_batch_hand_membership WHERE batch_key=ANY(ARRAY['0001','0002']))
 SELECT jsonb_agg(jsonb_build_object('ord',t.ord,'old',EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_batch_hand_membership x WHERE x.batch_key=t.batch_key AND x.hand_digest=t.hand_digest),'new',m.hand_digest IS NOT NULL)ORDER BY t.ord)
 FROM tuples t LEFT JOIN matches m USING(hand_digest,batch_key)"""
 rows=json.loads(q(exact));assert len(rows)==6 and all(r['old']==r['new']for r in rows)
 plan=json.loads(q("EXPLAIN(FORMAT JSON)SELECT hand_digest,batch_key FROM smarter_private.horse_adaptive_batch_hand_membership WHERE batch_key=ANY(ARRAY['0001','0002'])"))[0]['Plan'];assert any(n['Node Type']=='Index Only Scan'and n.get('Index Name')=='horse_adaptive_membership_batch_cover'and 'batch_key = ANY'in n.get('Index Cond','')for n in walk(plan))
 q('DROP INDEX smarter_private.horse_adaptive_membership_batch_cover');q('CREATE INDEX horse_adaptive_membership_batch_cover ON smarter_private.horse_adaptive_batch_hand_membership(hand_digest,batch_key)')
 try:q(body);raise AssertionError('wrong named index accepted')
 except subprocess.CalledProcessError as e:assert 'adaptive_membership_batch_cover_shape_changed'in e.stderr
 q('DROP INDEX smarter_private.horse_adaptive_membership_batch_cover');q('CREATE INDEX horse_adaptive_membership_batch_cover ON smarter_private.horse_adaptive_batch_hand_membership(batch_key text_pattern_ops,hand_digest)')
 try:q(body);raise AssertionError('wrong opclass accepted')
 except subprocess.CalledProcessError as e:assert 'adaptive_membership_batch_cover_shape_changed'in e.stderr
 q('DROP INDEX smarter_private.horse_adaptive_membership_batch_cover');q('CREATE INDEX horse_adaptive_membership_batch_cover ON smarter_private.horse_adaptive_batch_hand_membership(batch_key COLLATE "C",hand_digest)')
 try:q(body);raise AssertionError('wrong collation accepted')
 except subprocess.CalledProcessError as e:assert 'adaptive_membership_batch_cover_shape_changed'in e.stderr
 q('DROP INDEX smarter_private.horse_adaptive_membership_batch_cover');q(shape['indexes'][0]['statement']);q(body)
 result={'status':'PASS','production_access':False,'migration_sha256':hashlib.sha256(raw).hexdigest(),'checks':['maintained_concurrent_preamble_parser','native_concurrent_build_valid_ready_live','wrong_named_shape_refused','wrong_text_pattern_opclass_refused','wrong_explicit_collation_refused','batch_prefix_IndexOnlyScan','exact_pair_semantics_duplicates_NULL_missing_malformed'],'plan':plan};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items()if k!='plan'}))
finally:
 if started:run([PG/'pg_ctl','-D',root/'d','-m','immediate','-w','stop'])
 shutil.rmtree(root)

# The maintained CI entrypoint covers both retirement verification indexes.
run([os.sys.executable,ROOT/'scripts/ci/test-adaptive-ledger-digest-probe.py','--scratch',a.scratch,'--output',a.output.with_name(a.output.stem+'-digest-probe'+a.output.suffix)])

# The same directly triggered CI entrypoint qualifies the journal metadata cover.
run([os.sys.executable,ROOT/'scripts/ci/test-adaptive-journal-metadata-cover.py','--scratch',a.scratch,'--output',a.output.with_name(a.output.stem+'-journal-cover'+a.output.suffix)])
