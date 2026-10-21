import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
const parent=process.argv[2];if(!parent)throw Error('Pass owned scratch directory');
mkdirSync(parent,{recursive:true});const dir=mkdtempSync(path.join(parent,'dm-'));const sock=path.join(dir,'s');mkdirSync(sock);
const bin=process.env.PG_BIN||execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const run=(name,args,input)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',input,maxBuffer:12000000});
const sql=q=>run('psql',['-X','-At','-v','ON_ERROR_STOP=1','-h',sock,'-p','55479','-U','postgres','-d','postgres'],q).trim();
const data=JSON.parse(readFileSync(path.join(here,'captured.json'),'utf8'));
const orig=readFileSync(path.join(here,'original.sql'),'utf8');
const migration=readFileSync(path.join(root,'supabase/migrations/20261021173713_daily_metrics_health_materializes_original_human_classifier.sql'),'utf8');
const fixed=data.health.replace('SELECT jsonb_build_object(', 'WITH digest_health_humans AS MATERIALIZED (SELECT id FROM smarter_private.sp_real_humans) SELECT jsonb_build_object(').replaceAll('smarter_private.sp_real_humans hu','digest_health_humans hu');
const uuid=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
let running=false;
try{
run('initdb',['-D',path.join(dir,'db'),'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
run('pg_ctl',['-D',path.join(dir,'db'),'-l',path.join(dir,'log'),'-o',`-k ${sock} -p 55479 -c listen_addresses='' -c shared_buffers=16MB`,'-w','start']);running=true;
let setup='CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA smarter_private;SET check_function_bodies=off;';
const tables=new Map();for(const x of data.columns){if(!tables.has(x.table_name))tables.set(x.table_name,[]);let type=x.data_type==='USER-DEFINED'?'text':x.data_type==='ARRAY'?'text[]':x.data_type;tables.get(x.table_name).push(`"${x.column_name}" ${type}`);}
for(const [name,cols] of tables)setup+=`CREATE TABLE public.${name}(${cols.join(',')});`;
setup+=`CREATE TABLE auth.users(id uuid,email text,is_anonymous boolean,email_confirmed_at timestamptz);CREATE TABLE ca_cert_accounts(user_id uuid,active boolean);CREATE VIEW smarter_private.sp_real_humans AS ${data.view};${orig};REVOKE ALL ON FUNCTION fn_sp_daily_metrics_compute(date) FROM PUBLIC;GRANT EXECUTE ON FUNCTION fn_sp_daily_metrics_compute(date) TO service_role;`;
sql(setup);assert.equal(sql("SELECT md5(pg_get_functiondef('fn_sp_daily_metrics_compute(date)'::regprocedure))"),'578cb5d7c2f80139eefa395a59cbd3d0');
for(let i=1;i<=6;i++)sql(`INSERT INTO profiles(id,username,email,is_horse) VALUES('${uuid(i)}','player${i}','user${i}@ordinary.com',${i===3?'true':'false'});INSERT INTO auth.users VALUES('${uuid(i)}','user${i}@ordinary.com',${i===4?'true':'false'},now());`);
sql(`INSERT INTO ca_cert_accounts VALUES('${uuid(5)}',true);INSERT INTO ca_collusion_signals(id,user_a,user_b,detected_at,both_cert) VALUES
(1,'${uuid(1)}','${uuid(3)}','2026-10-20 05:00Z',false),
(2,'${uuid(1)}','${uuid(1)}','2026-10-20 06:00Z',false),
(3,NULL,'${uuid(2)}','2026-10-20 07:00Z',NULL),
(4,'${uuid(3)}','${uuid(4)}','2026-10-20 08:00Z',false),
(5,'${uuid(5)}','${uuid(99)}','2026-10-20 09:00Z',false),
(6,NULL,NULL,'2026-10-20 10:00Z',false),
(7,'${uuid(1)}','${uuid(2)}','2026-10-20 11:00Z',true),
(8,'${uuid(1)}','${uuid(2)}','2026-10-21 05:00Z',false),
(9,'${uuid(1)}','${uuid(2)}','2026-10-20 04:59Z',false);`);
const before=JSON.parse(sql(data.health));const after=JSON.parse(sql(fixed));assert.deepEqual(after,before);assert.equal(after.collusion_signals,3);assert.equal(after.collusion_signals_horse_only,3);
for(const mode of ['force_generic_plan','force_custom_plan']){const rows=sql(`SET plan_cache_mode=${mode};PREPARE original AS ${data.health};PREPARE revised AS ${fixed};EXECUTE original;EXECUTE revised;`).split('\n').filter(x=>x.startsWith('{'));assert.equal(rows.length,2);assert.deepEqual(JSON.parse(rows[0]),JSON.parse(rows[1]));assert.deepEqual(JSON.parse(rows[1]),before);}
const healthPlan=JSON.parse(sql('EXPLAIN (ANALYZE, FORMAT JSON) '+fixed))[0].Plan;let cte;const visit=n=>{if(n['Subplan Name']==='CTE digest_health_humans')cte=n;for(const p of n.Plans||[])visit(p);};visit(healthPlan);assert.equal(cte?.['Actual Loops'],1,'classifier evaluates exactly once');
sql(migration);const def=sql("SELECT pg_get_functiondef('fn_sp_daily_metrics_compute(date)'::regprocedure)");assert.ok(def.includes('WITH digest_health_humans AS MATERIALIZED'));assert.equal((def.match(/FROM digest_health_humans hu/g)||[]).length,2);
const removed=def.replace('  -- Resolve the original classifier once, rather than once per signal.\n  WITH digest_health_humans AS MATERIALIZED (SELECT id FROM smarter_private.sp_real_humans)\n','').replaceAll('FROM digest_health_humans hu','FROM smarter_private.sp_real_humans hu');assert.equal(removed,orig.trim());
assert.equal(sql("SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='fn_sp_daily_metrics_compute(date)'::regprocedure"),'t');
let refused=false;try{sql(migration);}catch(e){refused=String(e.stderr).includes('daily_metrics_health_preimage_changed');}assert.ok(refused);
console.log(JSON.stringify({status:'PASS',health_json_equivalent:true,signal_cases:9,humans:3,horse_only:3,null_and_same_endpoint_and_boundary:true,modes:2,source_reverse_bytes:true,acl_preserved:true,replay_refused:true,postimage:sql("SELECT md5(pg_get_functiondef('fn_sp_daily_metrics_compute(date)'::regprocedure))")}));
}finally{if(running)run('pg_ctl',['-D',path.join(dir,'db'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
