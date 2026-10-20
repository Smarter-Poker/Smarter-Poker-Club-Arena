// Real PG17 two-session original last-member transition; no production access.
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'../../..');
const parent=process.argv[2];if(!parent)throw Error('Pass owned scratch directory');
mkdirSync(parent,{recursive:true});const dir=mkdtempSync(path.join(parent,'storm-'));const socket=path.join(dir,'s');mkdirSync(socket);
const bin=process.env.PG_BIN||execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const run=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',maxBuffer:8e6});
const args=['-X','-At','-v','ON_ERROR_STOP=1','-h',socket,'-p','55479','-U','postgres','-d','postgres'];
const sql=q=>execFileSync(path.join(bin,'psql'),args,{input:q,encoding:'utf8',maxBuffer:8e6}).trim();
const schema=readFileSync(path.join(root,'scripts/ci/probes/production-alert-core/notification/inputs/schema.sql'),'utf8');
let setup='CREATE ROLE service_role;CREATE ROLE anon;CREATE ROLE authenticated;';
for(const name of ['ca_detector_registry','ca_drift_incidents','ca_incident_events','ca_incident_file_failures','financial_alerts']){
 setup+=schema.match(new RegExp('CREATE TABLE "public"\\."'+name+'"\\([\\s\\S]*?\\);'))[0];
 setup+=schema.split('\n').filter(x=>x.startsWith('ALTER TABLE "public"."'+name+'" ALTER COLUMN')&&x.includes(' SET DEFAULT ')).join('\n');
}
setup+=`ALTER TABLE ca_detector_registry ADD PRIMARY KEY(source);ALTER TABLE financial_alerts ADD PRIMARY KEY(id);ALTER TABLE ca_drift_incidents ADD PRIMARY KEY(id);ALTER TABLE ca_drift_incidents ADD COLUMN closure_basis text;
CREATE UNIQUE INDEX storm_open_key ON ca_drift_incidents(dedupe_key) WHERE status<>'resolved';
-- Only surrounding routing is substituted in this small concurrency slice.
-- Existing hosted connected fixture independently invokes the same qualifier
-- with its authentic full financial/incident/notification graph.
CREATE FUNCTION fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION fn_ca_normalize_alert_text(text) RETURNS text LANGUAGE sql AS 'SELECT $1';
CREATE FUNCTION fn_ca_is_cert_account(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE FUNCTION fn_ca_stable_dedupe_key(text) RETURNS text LANGUAGE sql AS 'SELECT $1';
CREATE FUNCTION fn_raise_server_financial_alert(text,text,text,jsonb) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
CREATE FUNCTION fn_ca_incident_notify(uuid,text,text,boolean) RETURNS void LANGUAGE sql AS 'SELECT';
CREATE FUNCTION fn_ca_declare_guard_redefinition(text,text) RETURNS void LANGUAGE sql AS 'SELECT';`;
let running=false;
const clients=[];
try{
 run('initdb',['-D',path.join(dir,'db'),'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 run('pg_ctl',['-D',path.join(dir,'db'),'-l',path.join(dir,'log'),'-o',`-k ${socket} -p 55479 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=15`,'-w','start']);running=true;
 assert.ok(Number(sql("SHOW server_version_num"))>=170000&&Number(sql("SHOW server_version_num"))<180000,'actual PostgreSQL17');
 sql(setup);
 const appendOnly=schema.match(/CREATE OR REPLACE FUNCTION public.fn_ca_incident_events_append_only\(\)[\s\S]*?\$function\$;/)[0];
 sql(appendOnly);sql('CREATE TRIGGER trg_ca_incident_events_append_only BEFORE DELETE OR UPDATE ON ca_incident_events FOR EACH ROW EXECUTE FUNCTION fn_ca_incident_events_append_only();');
 sql(readFileSync(path.join(root,'scripts/qualification/fixtures/tournament-finish-storm/preimages.sql'),'utf8'));
 sql(readFileSync(path.join(root,'scripts/qualification/fixtures/tournament-finish-storm/current-bridge.sql'),'utf8'));
 sql('CREATE TRIGGER financial_bridge AFTER INSERT ON financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_financial_alert_to_incident();');
 sql('CREATE TRIGGER resolution AFTER UPDATE OF resolved ON financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_alert_resolution_reaches_the_incident();');
 run('psql',[...args,'-f',path.join(root,'scripts/qualification/tournament-finish-storm-members.sql')]);
 sql(readFileSync(path.join(root,'supabase/components/tournament-finish-storm-members.sql'),'utf8'));
 const a='11111111-1111-4111-8111-000000000001',b='11111111-1111-4111-8111-000000000002';
 sql(`INSERT INTO ca_drift_incidents(source,dedupe_key)SELECT 'financial_alerts:Tournament.atomic_finish_refused','race-filler:'||n FROM generate_series(1,25)n;
 INSERT INTO financial_alerts(id,severity,source,message,resolved,resolved_at)VALUES('${a}','critical','Tournament.atomic_finish_refused','first',true,now()),('${b}','critical','Tournament.atomic_finish_refused','second',true,now());
 UPDATE financial_alerts SET resolved=false,resolved_at=NULL WHERE id IN('${a}','${b}');
 SELECT fn_ca_raise_drift_incident(p_source=>'financial_alerts:Tournament.atomic_finish_refused',p_classification=>'unknown',p_severity=>'critical',p_dedupe_key=>'race:a',p_discrepancy=>0,p_metadata=>jsonb_build_object('alert_id','${a}'));
 SELECT fn_ca_raise_drift_incident(p_source=>'financial_alerts:Tournament.atomic_finish_refused',p_classification=>'unknown',p_severity=>'critical',p_dedupe_key=>'race:b',p_discrepancy=>0,p_metadata=>jsonb_build_object('alert_id','${b}'));`);
 const client=()=>{const p=spawn(path.join(bin,'psql'),args);let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);const done=new Promise((resolve,reject)=>p.on('exit',c=>c===0?resolve(out):reject(Error(err))));clients.push(p);return {p,done};};
 const first=client();first.p.stdin.write(`BEGIN;UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id='${a}';\\echo FIRST_READY\n`);
 // Observe the holder transaction itself, never infer race overlap from a delay.
 let ready=false;const until=Date.now()+5000;
 while(Date.now()<until){if(sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query LIKE 'UPDATE financial_alerts SET resolved=true%'")==='1'){ready=true;break;}await new Promise(r=>setTimeout(r,20));}
 assert.ok(ready,'first last-member transition holds aggregate lock');
 const second=client();second.p.stdin.end(`UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id='${b}';`);
 let blocked=false;const waitUntil=Date.now()+3000;
 while(Date.now()<waitUntil){if(sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE financial_alerts SET resolved=true%'")==='1'){blocked=true;break;}await new Promise(r=>setTimeout(r,20));}
 assert.ok(blocked,'second last-member resolution actually waits on aggregate lock');
 first.p.stdin.end('COMMIT;\n');await Promise.all([first.done,second.done]);
 assert.equal(sql("SELECT status FROM ca_drift_incidents WHERE dedupe_key='storm:financial_alerts:Tournament.atomic_finish_refused'"),'resolved');
 assert.equal(sql('SELECT count(*) FROM ca_incident_file_failures'),'0');
 console.log('PASS actual PG17 fail-before/pass-after, member boundaries and observed concurrent last-member lock/commit');
 const hashes=sql("SELECT proname,md5(pg_get_functiondef(oid)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('fn_ca_raise_drift_incident','fn_ca_alert_resolution_reaches_the_incident') ORDER BY proname");console.log(hashes);
 execFileSync(process.execPath,[path.join(root,'scripts/qualification/tournament-finish-storm/historical.mjs'),parent],{stdio:'inherit',env:process.env});
}finally{
 for(const p of clients)if(p.exitCode===null)p.kill('SIGKILL');
 if(running)run('pg_ctl',['-D',path.join(dir,'db'),'-m','immediate','-w','stop']);
 rmSync(dir,{recursive:true,force:true});
}
