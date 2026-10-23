#!/usr/bin/env python3
"""Qualify the exact additive journal metadata cover on disposable PostgreSQL17."""
import argparse,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
assert a.scratch.is_dir()and not a.output.exists()
PG=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));migration=ROOT/'supabase/migrations/20261022223439_adaptive_journal_metadata_cover.sql';raw=migration.read_bytes();text=raw.decode();body=text[text.index('BEGIN;'):]
r=Path(tempfile.mkdtemp(prefix='ajc-',dir=a.scratch));started=False
assert len(str(r).encode())<85,'use a short SSD Unix socket scratch path'
psql=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',r,'-U','postgres','-d','postgres']
def run(args):return subprocess.run([str(x)for x in args],check=True,capture_output=True,text=True,timeout=120)
def q(sql):return run(psql+['-c',sql]).stdout.strip()
def walk(plan):
 yield plan
 for child in plan.get('Plans',[]):yield from walk(child)
def refuse(sql,reason):
 try:q(sql);raise AssertionError('expected refusal: '+reason)
 except subprocess.CalledProcessError as e:assert reason in e.stderr,e.stderr
try:
 run([PG/'initdb','-D',r/'d','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8']);run([PG/'pg_ctl','-D',r/'d','-l',r/'log','-o',"-k "+str(r)+" -c listen_addresses=''",'-w','start']);started=True
 table='public.horse_adaptive_observation_journal';index='public.horse_adaptive_journal_metadata_cover'
 q('CREATE TABLE '+table+'(observation_id text PRIMARY KEY,hand_id uuid NOT NULL,observed_at_ms bigint NOT NULL,payload text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),actor_key text,scope_key text,partition text,origin text);CREATE INDEX horse_adaptive_journal_retention ON '+table+'(recorded_at,observation_id);CREATE INDEX horse_adaptive_journal_scope_window ON '+table+'(actor_key,scope_key,partition,origin,observed_at_ms,observation_id)')
 q("INSERT INTO "+table+"(observation_id,hand_id,observed_at_ms,payload)SELECT(md5(n::text)::uuid)::text||':4095',md5(n::text)::uuid,n,'unchanged' FROM generate_series(1,20000)n")
 assert q('SELECT max(octet_length(observation_id))FROM '+table)=='41'
 # All actual metadata is retained, including malformed IDs and mismatched hand IDs.
 q("INSERT INTO "+table+"(observation_id,hand_id,observed_at_ms,payload)VALUES('', '00000000-0000-0000-0000-000000000001',0,'empty'),('noncanonical', '00000000-0000-0000-0000-000000000002',1,'malformed'),('00000000-0000-0000-0000-000000000003:0','00000000-0000-0000-0000-000000000004',1791158400000,'actual hand differs')")
 canonical="SELECT encode(sha256(convert_to(string_agg(jsonb_build_array(observation_id,hand_id,observed_at_ms)::text,E'\\n' ORDER BY observation_id),'UTF8')),'hex')FROM "+table
 baseline=q(canonical);existing=q("SELECT jsonb_object_agg(c.relname,c.oid)FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='"+table+"'::regclass")
 module=(ROOT/'scripts/ci/migration-concurrent-preamble.mjs').as_uri();code="import{readFileSync}from'node:fs';import{splitConcurrentPreamble}from'"+module+"';const s=splitConcurrentPreamble(readFileSync(process.argv[1],'utf8'));if(!s.ok||s.indexes.length!==1)throw Error('shape');console.log(JSON.stringify(s));"
 shape=json.loads(run(['node','--input-type=module','-e',code,migration]).stdout);assert shape['body']==body
 q(shape['indexes'][0]['statement']);q(body);q('VACUUM ANALYZE '+table)
 assert q(canonical)==baseline
 for name,oid in json.loads(existing).items():assert q("SELECT oid::text FROM pg_class WHERE oid=to_regclass('public."+name+"')")==str(oid)
 assert q("SELECT indisvalid AND indisready AND indislive AND NOT indisunique FROM pg_index WHERE indexrelid='"+index+"'::regclass")=='t'
 # This selective bounded query must get actual values from the cover, not derive a UUID.
 query="SELECT observation_id,hand_id,observed_at_ms FROM "+table+" WHERE observation_id>'10000000' ORDER BY observation_id LIMIT 1000"
 plan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+query))[0]['Plan'];nodes=list(walk(plan));assert any(n.get('Node Type')=='Index Only Scan'and n.get('Index Name')=='horse_adaptive_journal_metadata_cover'and n.get('Heap Fetches')==0 for n in nodes)
 assert q("SELECT hand_id::text FROM "+table+" WHERE observation_id='00000000-0000-0000-0000-000000000003:0'")=='00000000-0000-0000-0000-000000000004'
 assert q("SELECT observation_id=''FROM "+table+' ORDER BY observation_id LIMIT 1')=='t'
 refuse("INSERT INTO "+table+" SELECT*FROM "+table+" WHERE observation_id=''",'duplicate key')
 wrong=[('include_missing','(observation_id) INCLUDE(hand_id)'),('include_order','(observation_id) INCLUDE(observed_at_ms,hand_id)'),('wrong_key','(hand_id) INCLUDE(observation_id,observed_at_ms)'),('direction','(observation_id DESC) INCLUDE(hand_id,observed_at_ms)'),('opclass','(observation_id text_pattern_ops) INCLUDE(hand_id,observed_at_ms)'),('collation','(observation_id COLLATE "C") INCLUDE(hand_id,observed_at_ms)'),('predicate','(observation_id) INCLUDE(hand_id,observed_at_ms) WHERE observed_at_ms>=0'),('expression','(lower(observation_id)) INCLUDE(hand_id,observed_at_ms)')]
 checks=[]
 for label,definition in wrong:
  q('DROP INDEX '+index);q('CREATE INDEX horse_adaptive_journal_metadata_cover ON '+table+' '+definition);refuse(body,'adaptive_journal_metadata_cover_shape_changed');checks.append('wrong_'+label+'_refused')
 q('DROP INDEX '+index);q('CREATE UNIQUE INDEX horse_adaptive_journal_metadata_cover ON '+table+'(observation_id) INCLUDE(hand_id,observed_at_ms)');refuse(body,'adaptive_journal_metadata_cover_shape_changed');checks.append('wrong_unique_refused')
 q('DROP INDEX '+index);q(shape['indexes'][0]['statement']);q(body)
 q('CREATE ROLE fixture_wrong_owner;ALTER TABLE '+table+' OWNER TO fixture_wrong_owner');refuse(body,'adaptive_journal_metadata_cover_shape_changed');q('ALTER TABLE '+table+' OWNER TO postgres');q(body);checks.append('wrong_owner_refused')
 q('ALTER TABLE '+table+' ALTER COLUMN observed_at_ms TYPE numeric');refuse(body,'adaptive_journal_metadata_cover_shape_changed');q('ALTER TABLE '+table+' ALTER COLUMN observed_at_ms TYPE bigint');q(body);checks.append('wrong_included_type_refused')
 # Supported IDs are at most41 ASCII bytes. Arbitrary near-BTree-limit direct
 # IDs have no table CHECK; demonstrate the real INCLUDE width risk explicitly.
 q('CREATE TABLE fixture_width(id text PRIMARY KEY,h uuid NOT NULL,ms bigint NOT NULL)')
 q("INSERT INTO fixture_width SELECT left(string_agg(md5(n::text),''),2670),'00000000-0000-0000-0000-000000000001',1 FROM generate_series(1,100)n")
 refuse('CREATE INDEX CONCURRENTLY fixture_width_cover ON fixture_width(id) INCLUDE(h,ms)','index row size')
 journal=(ROOT/'server/src/services/HorseAdaptiveObservationJournal.ts').read_text();append=(ROOT/'supabase/migrations/20260913175935_recoverable_horse_adaptive_journal_batches.sql').read_text()
 assert "Number(a[1].slice(37)) >= 4096"in journal and "split_part(o->>1,':',2)::integer>=4096"in append
 result={'status':'PASS','production_access':False,'migration_sha256':hashlib.sha256(raw).hexdigest(),'checks':['maintained_concurrent_preamble_parser','native_concurrent_cover_valid_ready_live','actual_metadata_hash_unchanged_empty_malformed_mismatched_hand_preserved','bounded_cover_IndexOnlyScan_zero_heapfetch_after_fixture_vacuum','original_PK_retention_scope_index_OIDs_preserved','duplicate_PK_still_refused','supported_max41byte_UUID_ordinal4095_inserted','unsupported_near_BTree_limit_direct_ID_width_risk_demonstrated']+checks,'numeric_plan':[ {k:v for k,v in node.items()if k in ['Node Type','Index Name','Actual Rows','Actual Loops','Heap Fetches','Shared Hit Blocks','Shared Read Blocks']}for node in nodes]};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
 if started:run([PG/'pg_ctl','-D',r/'d','-m','immediate','-w','stop'])
 shutil.rmtree(r)
