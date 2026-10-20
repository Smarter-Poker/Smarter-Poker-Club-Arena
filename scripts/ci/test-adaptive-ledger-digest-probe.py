#!/usr/bin/env python3
"""Qualify the exact retirement digest probe index on disposable PostgreSQL17."""
import argparse,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
assert a.scratch.is_dir() and not a.output.exists()
PG=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));migration=ROOT/'supabase/migrations/20261020170644_adaptive_legacy_digest_probe_index.sql';raw=migration.read_bytes();text=raw.decode();body=text[text.index('BEGIN;'):]
root=Path(tempfile.mkdtemp(prefix='ald-',dir=a.scratch));started=False
assert len(str(root).encode())<85,'use a short SSD scratch path for the Unix socket'
psql=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',root,'-U','postgres','-d','postgres']
def run(args):return subprocess.run([str(x)for x in args],check=True,capture_output=True,text=True,timeout=120)
def q(sql):return run(psql+['-c',sql]).stdout.strip()
def walk(plan):
 yield plan
 for child in plan.get('Plans',[]):yield from walk(child)
try:
 run([PG/'initdb','-D',root/'d','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8']);run([PG/'pg_ctl','-D',root/'d','-l',root/'log','-o',"-k "+str(root)+" -c listen_addresses=''",'-w','start']);started=True
 table='smarter_private.horse_adaptive_legacy_learning_purges';index='smarter_private.horse_adaptive_legacy_digest_probe'
 q("CREATE SCHEMA smarter_private;CREATE TABLE "+table+"(hand_id uuid PRIMARY KEY,hand_digest text NOT NULL UNIQUE);INSERT INTO "+table+" SELECT('abcdef00-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,encode(sha256(convert_to(n::text,'UTF8')),'hex')FROM generate_series(1,250000)n")
 module=(ROOT/'scripts/ci/migration-concurrent-preamble.mjs').as_uri();code="import{readFileSync}from'node:fs';import{splitConcurrentPreamble}from'"+module+"';const s=splitConcurrentPreamble(readFileSync(process.argv[1],'utf8'));if(!s.ok||s.indexes.length!==1)throw Error('shape');console.log(JSON.stringify(s));"
 shape=json.loads(run(['node','--input-type=module','-e',code,migration]).stdout);assert shape['body']==body
 q(shape['indexes'][0]['statement']);q(body);q('VACUUM ANALYZE '+table)
 assert q("SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='"+index+"'::regclass")=='t'
 fragment=(ROOT/'scripts/ci/legacy-digest-replay-probe.sql').read_bytes();fragment_text=fragment.decode()
 assert ' OFFSET 0\n' in fragment_text and 'WHERE matched.hand_digest=d.tuple_hand_digest;' in fragment_text
 query="WITH page_digests AS MATERIALIZED(SELECT encode(sha256(convert_to(n::text,'UTF8')),'hex') tuple_hand_digest FROM generate_series(249001,252000)n)\n"+fragment_text
 assert q(query)=='1000'
 expected="WITH probe AS MATERIALIZED(SELECT encode(sha256(convert_to(n::text,'UTF8')),'hex') d FROM generate_series(249001,252000)n)SELECT count(*)FROM probe x JOIN "+table+" p ON p.hand_digest=x.d";assert q(expected)=='1000'
 plan=json.loads(q('EXPLAIN(FORMAT JSON)'+query))[0]['Plan'];nodes=list(walk(plan));assert any(n.get('Index Name')=='horse_adaptive_legacy_digest_probe'for n in nodes);assert not any(n.get('Index Name')=='horse_adaptive_legacy_learning_purges_hand_digest_key'for n in nodes)
 # This stored digest intentionally differs from SHA256(hand_id); never derive it.
 assert q("SELECT count(*)FROM "+table+" WHERE hand_digest=encode(sha256(convert_to('7','UTF8')),'hex') AND hand_digest<>encode(sha256(convert_to(hand_id::text,'UTF8')),'hex')")=='1'
 # A fixture-only lossy expression guarantees collisions and exercises recheck.
 q("CREATE TABLE collision_ledger(d text NOT NULL);INSERT INTO collision_ledger VALUES('present'),('different');CREATE INDEX collision_hash ON collision_ledger((hashtextextended(d,0)%1))")
 collision="WITH probe(d)AS(VALUES('present'::text),('absent'::text))SELECT count(*)FROM probe x CROSS JOIN LATERAL(SELECT p.d FROM collision_ledger p WHERE hashtextextended(p.d,0)%1=hashtextextended(x.d,0)%1 OFFSET 0)m WHERE m.d=x.d"
 assert q(collision)=='1'and q(collision.replace(' WHERE m.d=x.d',''))=='4'
 wrong=[('seed','(hashtextextended(hand_digest,1))'),('direction','(hashtextextended(hand_digest,0) DESC)'),('opclass','(hashtextextended(hand_digest,0) int8_minmax_ops) USING_BRIN'),('include','(hashtextextended(hand_digest,0)) INCLUDE(hand_id)'),('type','(((hashtextextended(hand_digest,0))::numeric))'),('predicate','(hashtextextended(hand_digest,0)) WHERE hand_digest IS NOT NULL')]
 checks=[]
 for label,definition in wrong:
  q('DROP INDEX '+index)
  method='brin'if 'USING_BRIN'in definition else'btree';definition=definition.replace(' USING_BRIN','')
  q('CREATE INDEX horse_adaptive_legacy_digest_probe ON '+table+' USING '+method+' '+definition)
  try:q(body);raise AssertionError('wrong '+label+' accepted')
  except subprocess.CalledProcessError as e:assert 'adaptive_legacy_digest_probe_shape_changed'in e.stderr
  checks.append('wrong_'+label+'_refused')
 q('DROP INDEX '+index);q(shape['indexes'][0]['statement']);q(body)
 q('CREATE ROLE fixture_wrong_owner');q('ALTER TABLE '+table+' OWNER TO fixture_wrong_owner')
 try:q(body);raise AssertionError('wrong owner accepted')
 except subprocess.CalledProcessError as e:assert 'adaptive_legacy_digest_probe_shape_changed'in e.stderr
 q('ALTER TABLE '+table+' OWNER TO postgres');q(body)
 # Implicit column collation affects hashing even when pg_get_expr is unchanged.
 q('ALTER TABLE '+table+' ALTER COLUMN hand_digest TYPE text COLLATE "C" USING hand_digest::text')
 try:q(body);raise AssertionError('wrong column collation accepted')
 except subprocess.CalledProcessError as e:assert 'adaptive_legacy_digest_probe_shape_changed'in e.stderr
 q('ALTER TABLE '+table+' ALTER COLUMN hand_digest TYPE text COLLATE "default" USING hand_digest::text');q(body)
 checks.append('wrong_column_collation_refused_and_default_restored')
 assert q("SELECT count(*)FROM pg_index WHERE indexrelid='smarter_private.horse_adaptive_legacy_learning_purges_hand_digest_key'::regclass AND indisvalid AND indisunique")=='1'
 result={'status':'PASS','production_access':False,'migration_sha256':hashlib.sha256(raw).hexdigest(),'consumer_sha256':hashlib.sha256(fragment).hexdigest(),'checks':['maintained_concurrent_preamble_parser','native_concurrent_build_valid_ready_live','exact_maintained_consumer_OFFSET0_outer_equality','default_planner_expression_probe_without_settings','positive_negative_actual_stored_digest_exact_equality','non_UUID_derived_mapping_preserved','forced_collision_exact_outer_recheck','wrong_owner_refused','existing_unique_digest_preserved']+checks,'plan':plan};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items()if k!='plan'}))
finally:
 if started:run([PG/'pg_ctl','-D',root/'d','-m','immediate','-w','stop'])
 shutil.rmtree(root)
