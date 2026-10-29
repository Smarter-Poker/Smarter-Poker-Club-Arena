// Actual PG17 exact-original detector qualification; disposable Unix-only cluster.
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'../../..');
const parent=process.argv[2];if(!parent||!path.isAbsolute(parent))throw Error('Owned absolute scratch directory required');
mkdirSync(parent,{recursive:true});const dir=mkdtempSync(path.join(parent,'hro-'));const socket=path.join(dir,'s');mkdirSync(socket);
const bin=process.env.PG_BIN||execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const run=(name,args,input)=>execFileSync(path.join(bin,name),args,{input,encoding:'utf8',maxBuffer:4e6});
const sql=q=>run('psql',['-X','-At','-v','ON_ERROR_STOP=1','-h',socket,'-p','55488','-U','postgres','-d','postgres'],q).trim();
const preimage=readFileSync(path.join(root,'scripts/qualification/fixtures/hand-refusal-outcome/preimage.sql'),'utf8');
const migration=readFileSync(path.join(root,'supabase/migrations/20261029205730_hand_commit_detector_requires_exact_original_outcome.sql'),'utf8');
let running=false;
const count=()=>sql("SELECT COALESCE(sum(refusals),0) FROM fn_ca_hand_commit_refusals(24)");
const seed=()=>sql(`TRUNCATE financial_alerts,hand_atomic_commits,ca_drift_incidents;
 INSERT INTO hand_atomic_commits SELECT md5('hand'||g)::uuid,'21111111-1111-4111-8111-000000000001',52000000+g,repeat('a',64),repeat('b',64),repeat('c',64),'{}'::jsonb,now(),jsonb_build_object('ok',true,'hand_id',(md5('hand'||g)::uuid)::text,'hand_number',52000000+g) FROM generate_series(1,43)g;
 INSERT INTO financial_alerts SELECT md5('alert'||g)::uuid,'ServerTableEngine.authoritative_hand_semantic_refusal',now()-interval'10min',true,jsonb_build_object('error','atomic hand commit refused (lease_proof_expired)','channel','server_rpc','table_id','21111111-1111-4111-8111-000000000001','hand_number',52000000+g,'hand_request_identity_v1',jsonb_build_object('version',1,'hand_id',(md5('hand'||g)::uuid)::text,'table_id','21111111-1111-4111-8111-000000000001','hand_number',52000000+g,'post_commit_required',true)) FROM generate_series(1,43)g;`);
try{
 run('initdb',['-D',path.join(dir,'db'),'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 run('pg_ctl',['-D',path.join(dir,'db'),'-l',path.join(dir,'log'),'-o',`-k ${socket} -p 55488 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=5`,'-w','start']);running=true;
 assert.match(sql('SHOW server_version'),/^17[.]/);
 sql(`CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
 CREATE TABLE financial_alerts(id uuid PRIMARY KEY,source text,created_at timestamptz,resolved boolean,context jsonb);
 CREATE INDEX alert_source_time ON financial_alerts(source,created_at);
 CREATE TABLE hand_atomic_commits(hand_id uuid PRIMARY KEY,table_id uuid,hand_number bigint,payload_hash text,post_commit_request_hash text,post_commit_payload_hash text,post_commit_payload jsonb,post_commit_completed_at timestamptz,post_commit_result jsonb);
 CREATE TABLE ca_drift_incidents(source text,status text,resolved_at timestamptz,correction_ref text);
 CREATE FUNCTION fn_ca_declare_guard_redefinition(text,text) RETURNS text LANGUAGE sql AS 'SELECT NULL::text';`);
 sql(preimage);sql('REVOKE ALL ON FUNCTION fn_ca_hand_commit_refusals(integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION fn_ca_hand_commit_refusals(integer) TO postgres,service_role;');
 seed();assert.equal(count(),'43','actual old source restates all43 exact completed originals');
 console.log('PASS fail-before: actual installed detector reports43 completed exact originals');
 sql(migration);assert.equal(count(),'0','same-original accepted and required postcommit complete removes false finding');
 console.log('PASS after: all43 exact originals proven complete, immutable alerts retained');
 const cases=[
 ['manual resolved flag only',"UPDATE financial_alerts SET context=context-'hand_request_identity_v1'"],
 ['unresolved source flag does not defeat exact proof',"UPDATE financial_alerts SET resolved=false",'0'],
 ['wrong channel',"UPDATE financial_alerts SET context=jsonb_set(context,'{channel}','\"browser\"')"],
 ['unknown identity version',"UPDATE financial_alerts SET context=jsonb_set(context,'{hand_request_identity_v1,version}','null')"],
 ['obligations not required',"UPDATE financial_alerts SET context=jsonb_set(context,'{hand_request_identity_v1,post_commit_required}','false')"],
 ['malformed hand UUID',"UPDATE financial_alerts SET context=jsonb_set(context,'{hand_request_identity_v1,hand_id}','\"invalid\"')"],
 ['different later hand',"UPDATE financial_alerts SET context=jsonb_set(context,'{hand_request_identity_v1,hand_id}','\"31111111-1111-4111-8111-000000000001\"')"],
 ['mismatched table identity',"UPDATE financial_alerts SET context=jsonb_set(context,'{table_id}','\"31111111-1111-4111-8111-000000000001\"')"],
 ['wrong committed table',"UPDATE hand_atomic_commits SET table_id='31111111-1111-4111-8111-000000000001'"],
 ['wrong committed number',"UPDATE hand_atomic_commits SET hand_number=hand_number+1"],
 ['numeric string is not hand number',"UPDATE financial_alerts SET context=jsonb_set(jsonb_set(context,'{hand_number}',to_jsonb(context->>'hand_number')),'{hand_request_identity_v1,hand_number}',to_jsonb(context->>'hand_number'))"],
 ['invalid original acceptance hash',"UPDATE hand_atomic_commits SET payload_hash=''"],
 ['invalid request hash',"UPDATE hand_atomic_commits SET post_commit_request_hash=''"],
 ['invalid payload hash',"UPDATE hand_atomic_commits SET post_commit_payload_hash=''"],
 ['missing obligation payload',"UPDATE hand_atomic_commits SET post_commit_payload='null'"],
 ['incomplete obligations',"UPDATE hand_atomic_commits SET post_commit_completed_at=NULL"],
 ['unsuccessful completion',"UPDATE hand_atomic_commits SET post_commit_result=jsonb_set(post_commit_result,'{ok}','false')"],
 ['wrong completion original',"UPDATE hand_atomic_commits SET post_commit_result=jsonb_set(post_commit_result,'{hand_id}','\"31111111-1111-4111-8111-000000000001\"')"],
 ['wrong completion number',"UPDATE hand_atomic_commits SET post_commit_result=jsonb_set(post_commit_result,'{hand_number}','1')"]
 ];
 for(const [name,change,expected='43']of cases){seed();sql(change);assert.equal(count(),expected,name);}
 seed();sql('UPDATE hand_atomic_commits SET post_commit_completed_at=NULL WHERE hand_number<=52000025');assert.equal(count(),'25','floor25 stillreports exact pending originals');
 sql('DELETE FROM financial_alerts WHERE context->>\'hand_number\'=\'52000025\'');assert.equal(count(),'0','existing floor25 unchanged');
 seed();sql("UPDATE financial_alerts SET context=context-'hand_request_identity_v1'; INSERT INTO ca_drift_incidents VALUES('fn_ca_conservation_sweep:fn_ca_hand_commit_refusals','resolved',now(),'verified original detector correction')");assert.equal(count(),'0','existing correction watermark unchanged');
 assert.equal(sql('SELECT count(*) FROM financial_alerts'),'43','source history retained');
 assert.equal(sql("SELECT pg_get_userbyid(proowner)||'|'||prosecdef||'|'||proconfig::text||'|'||proacl::text FROM pg_proc WHERE oid='fn_ca_hand_commit_refusals(integer)'::regprocedure"),'postgres|true|{"search_path=public, pg_temp"}|{postgres=X/postgres,service_role=X/postgres}');
 console.log('PASS exact proof, unknown/manual/later-hand boundaries, floor, watermark and unchanged authority');
 console.log('POSTHASH '+sql("SELECT md5(pg_get_functiondef('fn_ca_hand_commit_refusals(integer)'::regprocedure))"));
}finally{if(running)run('pg_ctl',['-D',path.join(dir,'db'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
