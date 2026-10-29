// Actual PostgreSQL 17 bridge -> incident -> resolution qualification.
// Disposable Unix socket database only; no production access or money writes.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '../../..');
const parent = process.argv[2];
if (!parent || !path.isAbsolute(parent)) throw Error('Pass an owned absolute scratch directory');
mkdirSync(parent, { recursive: true });
const dir = mkdtempSync(path.join(parent, 'hii-'));
const socket = path.join(dir, 's'); mkdirSync(socket);
const bin = process.env.PG_BIN || execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
const run = (name, args, input) => execFileSync(path.join(bin, name), args, { input, encoding: 'utf8', maxBuffer: 4e6 });
const args = ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '55489', '-U', 'postgres', '-d', 'postgres'];
const sql = q => run('psql', args, q).trim();
const schema = readFileSync(path.join(root, 'scripts/ci/probes/production-alert-core/notification/inputs/schema.sql'), 'utf8');
const source = readFileSync(path.join(root, 'scripts/qualification/fixtures/hand-history-incident-identity/preimages.sql'), 'utf8');
const migration = path.join(root, 'supabase/migrations/20261029180738_hand_history_incidents_retain_exact_original_identity.sql');
const a = '11111111-1111-4111-8111-000000000001';
const b = '11111111-1111-4111-8111-000000000002';
const t1 = '21111111-1111-4111-8111-000000000001';
const t2 = '21111111-1111-4111-8111-000000000002';
const sourceName = 'postHandTasks.hand_history_failed';
const insert = (id, table, hand, extra = '') => `INSERT INTO financial_alerts(id,severity,source,message,context)
 VALUES('${id}','critical','${sourceName}','Post-hand step hand_history threw for hand #${String(hand).replace(/\D/g,'')}; later steps continued',
 jsonb_build_object('table_id','${table}','hand_number',${hand},'error','atomic hand commit refused (lease_proof_expired)','moves_chips',true)${extra});`;
const status = id => sql(`SELECT status FROM ca_drift_incidents WHERE metadata->>'alert_id'='${id}'`);
const resolve = id => sql(`UPDATE financial_alerts SET resolved=true,resolved_at=now(),resolution='isolated exact original completion receipt' WHERE id='${id}';`);
let running = false;
const clients = [];
try {
 run('initdb', ['-D', path.join(dir, 'db'), '-U', 'postgres', '-A', 'trust', '--no-locale', '--encoding=UTF8']);
 run('pg_ctl', ['-D', path.join(dir, 'db'), '-l', path.join(dir, 'log'), '-o', `-k ${socket} -p 55489 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10`, '-w', 'start']); running = true;
 assert.match(sql('SHOW server_version'), /^17[.]/, 'actual PostgreSQL 17');
 let setup = 'CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;';
 for (const name of ['ca_detector_registry', 'ca_drift_incidents', 'ca_incident_events', 'ca_incident_file_failures', 'financial_alerts']) {
   setup += schema.match(new RegExp('CREATE TABLE "public"[.]"' + name + '"\\([\\s\\S]*?\\);'))[0];
   setup += schema.split('\n').filter(x => x.startsWith('ALTER TABLE "public"."' + name + '" ALTER COLUMN') && x.includes(' SET DEFAULT ')).join('\n');
 }
 setup += `ALTER TABLE ca_detector_registry ADD PRIMARY KEY(source);
 ALTER TABLE financial_alerts ADD PRIMARY KEY(id); ALTER TABLE ca_drift_incidents ADD PRIMARY KEY(id);
 ALTER TABLE ca_drift_incidents ADD COLUMN closure_basis text;
 CREATE UNIQUE INDEX identity_open_key ON ca_drift_incidents(dedupe_key) WHERE status<>'resolved';
 -- Only surrounding routing is substituted; the real maintained producer,
 -- normalizer, raiser and resolution transition execute below.
 CREATE FUNCTION fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT true';
 CREATE FUNCTION fn_ca_is_cert_account(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
 CREATE FUNCTION fn_raise_server_financial_alert(text,text,text,jsonb) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
 CREATE FUNCTION fn_ca_incident_notify(uuid,text,text,boolean) RETURNS void LANGUAGE sql AS 'SELECT';
 CREATE FUNCTION fn_ca_declare_guard_redefinition(text,text) RETURNS text LANGUAGE sql AS 'SELECT md5(pg_get_functiondef(to_regprocedure(''public.''||$1||''()'')))';
 `;
 const stableMigration = readFileSync(path.join(root, 'supabase/migrations/20260906095606_one_condition_is_one_incident_counted_in_chips_that_closes_w.sql'), 'utf8');
 setup += stableMigration.match(/CREATE OR REPLACE FUNCTION public[.]fn_ca_stable_dedupe_key[\s\S]*?\$fn\$;/)[0];
 sql(setup); sql(source);
 sql(`REVOKE ALL ON FUNCTION fn_ca_financial_alert_to_incident(),fn_ca_alert_resolution_reaches_the_incident() FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION fn_ca_financial_alert_to_incident(),fn_ca_alert_resolution_reaches_the_incident() TO postgres,service_role;
 CREATE TRIGGER financial_bridge AFTER INSERT ON financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_financial_alert_to_incident();
 CREATE TRIGGER resolution AFTER UPDATE OF resolved ON financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_alert_resolution_reaches_the_incident();`);
 // Actual old source loses the first original when the latest alert closes.
 sql('BEGIN;' + insert(a, t1, 51853419) + insert(b, t2, 51860852) + `UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id='${b}';
 DO $$BEGIN IF (SELECT count(*) FROM ca_drift_incidents)<>1 OR NOT EXISTS(SELECT 1 FROM ca_drift_incidents WHERE status='resolved' AND table_id='${t1}' AND metadata->>'table_id'='${t2}') THEN RAISE EXCEPTION 'old source no longer reproduces collision and premature closure'; END IF; END $$;
 ROLLBACK;`);
 console.log('PASS fail-before: real old bridge folds different originals and latest resolution closes their shared incident');
 // Retain a live legacy group across the real migration to test transition.
 sql(insert(a, t1, 51853419) + insert(b, t2, 51860852));
 const before = sql('SELECT to_jsonb(i) FROM ca_drift_incidents i');
 run('psql', [...args, '-f', migration]);
 assert.equal(sql('SELECT to_jsonb(i) FROM ca_drift_incidents i'), before, 'migration preserves every historical incident byte');
 resolve(b); assert.equal(status(b), 'open', 'latest legacy resolution cannot hide earlier unresolved original');
 resolve(a); assert.equal(status(b), 'resolved', 'earlier final member closes only after complete legacy membership resolves');
 // Each separate call below completes its own disposable-database transaction.
 const c='11111111-1111-4111-8111-000000000003',d='11111111-1111-4111-8111-000000000004',e='11111111-1111-4111-8111-000000000005';
 sql(insert(c,t1,900001)+insert(d,t2,900001)+insert(e,t1,900002));
 assert.equal(sql("SELECT count(*) FROM ca_drift_incidents WHERE status='open'"),'3','different table or hand never shares an incident');
 resolve(d); assert.equal(status(c),'open'); assert.equal(status(e),'open'); assert.equal(status(d),'resolved');
 const duplicate='11111111-1111-4111-8111-000000000006';
 sql(insert(duplicate,t1,900001));
 assert.equal(sql(`SELECT occurrences FROM ca_drift_incidents WHERE metadata->>'alert_id'='${duplicate}'`),'2','same exact original still deduplicates');
 assert.equal(sql(`SELECT table_id::text=metadata->>'table_id' FROM ca_drift_incidents WHERE metadata->>'alert_id'='${duplicate}'`),'t','typed and metadata table identity agree');
 for (const [n, table, hand] of [[7,'not-a-uuid',900010],[8,'not-a-uuid',900010],[9,t1,"'900011'::text"],[10,t1,"'900011'::text"]]) {
  sql(insert('11111111-1111-4111-8111-'+String(n).padStart(12,'0'),table,hand));
 }
 assert.equal(sql("SELECT count(*) FROM ca_drift_incidents WHERE dedupe_key LIKE 'fa:postHandTasks.hand_history_failed:alert:%'"),'4','invalid table or numeric-string hand remains an individual unknown');
 // Missing historical membership cannot be coerced into all resolved.
 const unknown='11111111-1111-4111-8111-000000000011';
 sql(`INSERT INTO financial_alerts(id,severity,source,message,context,resolved)
 VALUES('${unknown}','critical','${sourceName}','legacy unknown hand #900013',
 '{"error":"isolated ambiguous legacy"}',true);
 UPDATE financial_alerts SET resolved=false WHERE id='${unknown}';
 INSERT INTO ca_drift_incidents(source,dedupe_key,occurrences,metadata,detected_at,last_seen_at)
 SELECT 'financial_alerts:'||source,'fa:'||source||':'||md5(fn_ca_normalize_alert_text(left(message,200))||'|'||fn_ca_normalize_alert_text(left(context->>'error',200))),
 2,jsonb_build_object('alert_id',id),created_at,created_at FROM financial_alerts WHERE id='${unknown}';`);
 resolve(unknown); assert.equal(status(unknown),'open','incomplete legacy membership remains unknown');
 const leave='11111111-1111-4111-8111-000000000012';
 sql(`INSERT INTO financial_alerts(id,severity,source,message,context)
 VALUES('${leave}','critical','postHandTasks.leave_pending_failed','isolated leave #900014',
 jsonb_build_object('table_id','${t1}','hand_number',900014,'error','isolated leave'));`);
 assert.equal(sql(`SELECT dedupe_key LIKE 'fa:postHandTasks.leave_pending_failed:table:${t1}:hand:900014:%'
 AND table_id='${t1}' FROM ca_drift_incidents WHERE metadata->>'alert_id'='${leave}'`),'t','existing leave identity remains exact');
 // Observe two actual last-member resolutions contending on the legacy row.
 const fixedBridge=sql("SELECT pg_get_functiondef('fn_ca_financial_alert_to_incident()'::regprocedure)");
 const legacyStart=source.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_financial_alert_to_incident()');
 const legacyEnd=source.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_normalize_alert_text',legacyStart);
 sql(source.slice(legacyStart,legacyEnd));
 const x='11111111-1111-4111-8111-000000000013',y='11111111-1111-4111-8111-000000000014';
 sql(insert(x,t1,900020)+insert(y,t2,900021));
 sql(fixedBridge+';');
 const client=()=>{const p=spawn(path.join(bin,'psql'),args);let out='',err='';p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);const done=new Promise((resolve,reject)=>p.on('exit',c=>c===0?resolve(out):reject(Error(err))));clients.push(p);return {p,done};};
 const first=client();first.p.stdin.write(`BEGIN;UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id='${x}';\\echo FIRST_READY\n`);
 let ready=false;const until=Date.now()+5000;
 while(Date.now()<until){if(sql(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query LIKE '%${x}%'`) === '1'){ready=true;break;}await new Promise(r=>setTimeout(r,20));}
 assert.ok(ready,'first original resolution holds legacy row before commit');
 const second=client();second.p.stdin.end(`UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id='${y}';`);
 let blocked=false;const deadline=Date.now()+3000;
 while(Date.now()<deadline){if(sql(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%${y}%'`) === '1'){blocked=true;break;}await new Promise(r=>setTimeout(r,20));}
 assert.ok(blocked,'second final-member transition actually waits for original group');
 first.p.stdin.end('COMMIT;\n');await Promise.all([first.done,second.done]);
 assert.equal(status(y),'resolved','concurrent last member observes predecessor commit and closes the exact group');
 console.log('PASS observed concurrent last-member lock, commit and exact closure');
 assert.equal(sql('SELECT count(*) FROM ca_incident_file_failures'),'0','no swallowed trigger failure');
 console.log('PASS after: table/hand boundaries, same-original recurrence, unknown identity, exact closure and unchanged history');
 console.log(sql("SELECT proname,md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid IN('fn_ca_financial_alert_to_incident()'::regprocedure,'fn_ca_alert_resolution_reaches_the_incident()'::regprocedure) ORDER BY proname"));
} finally {
 for (const p of clients) if (p.exitCode === null) p.kill('SIGKILL');
 if (running) run('pg_ctl', ['-D', path.join(dir,'db'), '-m','immediate','-w','stop']);
 rmSync(dir, { recursive:true, force:true });
}
