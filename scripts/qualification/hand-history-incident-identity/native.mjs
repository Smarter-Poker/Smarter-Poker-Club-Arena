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
const raiseSignature='fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)';
const sourceName = 'postHandTasks.hand_history_failed';
const insert = (id, table, hand, extra = '') => `INSERT INTO financial_alerts(id,severity,source,message,context)
 VALUES('${id}','critical','${sourceName}','Post-hand step hand_history threw for hand #${String(hand).replace(/\D/g,'')}; later steps continued',
 jsonb_build_object('table_id','${table}','hand_number',${hand},'error','atomic hand commit refused (lease_proof_expired)','moves_chips',true)${extra});`;
const status = id => sql(`SELECT status FROM ca_drift_incidents WHERE metadata->>'alert_id'='${id}'`);
const resolve = id => sql(`UPDATE financial_alerts SET resolved=true,resolved_at=now(),resolution='isolated exact original completion receipt' WHERE id='${id}';`);
const genericSource='Tournament.table_admission_failing';
const genericTables=['d5f844bf-a5bc-46a3-9249-ad4d07f64a90','59e70c2f-4405-4d82-bd20-4da0dd08f511','1f628903-22a1-4608-8c21-9def4f779420','f99bb8e8-250e-4181-9c4f-d124362236b5','856e9feb-7f01-4643-8f09-997a259f6cdc','dac21181-16b6-446a-9c90-8bfaba7de3c9'];
const genericIds=Array.from({length:6},(_,n)=>'31111111-1111-4111-8111-'+String(n+1).padStart(12,'0'));
const futureIds=Array.from({length:6},(_,n)=>'41111111-1111-4111-8111-'+String(n+1).padStart(12,'0'));
const genericInsert=(id,n)=>`INSERT INTO financial_alerts(id,severity,source,message,context)
 VALUES('${id}','critical','${genericSource}','Tournament ${t1} table ${genericTables[n]} has failed to start for 10 min; its seated players have no dealer. Last refusal: none recorded (recovery reason: hand_continuation_unproven)',
 jsonb_build_object('table_id','${genericTables[n]}','tournament_id','${t1}'));`;
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
 sql('REVOKE ALL ON FUNCTION '+raiseSignature+' FROM PUBLIC; GRANT EXECUTE ON FUNCTION '+raiseSignature+' TO postgres,service_role;');
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
 // The demonstrated admission group has six originals, three still unresolved.
 sql('BEGIN;'+genericIds.map(genericInsert).join('')+`UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id IN('${genericIds[0]}','${genericIds[4]}','${genericIds[5]}');
 DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM ca_drift_incidents WHERE source='financial_alerts:${genericSource}' AND status='resolved' AND occurrences=6) OR (SELECT count(*) FROM financial_alerts WHERE source='${genericSource}' AND NOT resolved)<>3 THEN RAISE EXCEPTION 'old generic source no longer reproduces six-member false closure'; END IF; END $$;`+
 futureIds.map(genericInsert).join('')+`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM ca_drift_incidents WHERE source='financial_alerts:${genericSource}' AND status='open' AND occurrences=5) THEN RAISE EXCEPTION 'old resolved echo no longer steals an active group member'; END IF; END $$;ROLLBACK;`);
 console.log('PASS fail-before: six-member admission group closes with three unresolved originals; resolved echo steals an active member');
 for (let n=0;n<genericIds.length;n++) sql(genericInsert(genericIds[n],n));
 sql(insert(a, t1, 51853419)); sql(insert(b, t2, 51860852));
 const before = sql('SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM ca_drift_incidents i');
 run('psql', [...args, '-f', migration]);
 assert.equal(sql('SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM ca_drift_incidents i'), before, 'migration preserves every historical incident byte');
 resolve(b); assert.equal(status(b), 'open', 'latest legacy resolution cannot hide earlier unresolved original');
 resolve(a); assert.equal(status(b), 'resolved', 'earlier final member closes only after complete legacy membership resolves');
 // Each separate call below completes its own disposable-database transaction.
 for(const n of [0,4,5]) resolve(genericIds[n]);
 assert.equal(status(genericIds[5]),'open','legacy six-member admission group retains three unresolved originals');
 for(const n of [1,2,3]) resolve(genericIds[n]);
 assert.equal(status(genericIds[5]),'resolved','all exact immutable legacy event members must resolve');
 for(let n=0;n<futureIds.length;n++) sql(genericInsert(futureIds[n],n));
 assert.equal(sql(`SELECT occurrences FROM ca_drift_incidents WHERE metadata->>'alert_id'='${futureIds[5]}'`),'6','same-cause aggregation retained for future admission events');
 assert.equal(sql(`SELECT count(*)=6 AND count(DISTINCT detail->>'alert_id')=6 AND bool_and(detail->'financial_member_version'='1'::jsonb) FROM ca_incident_events WHERE incident_id=(SELECT id FROM ca_drift_incidents WHERE metadata->>'alert_id'='${futureIds[5]}') AND kind IN('created','recurred')`),'t','every immutable original member UUID is retained');
 assert.equal(sql(`SELECT occurrences FROM ca_drift_incidents WHERE metadata->>'alert_id'='${genericIds[5]}'`),'6','active group wins over byte-identical resolved history echo');
 for(const n of [0,4,5]) resolve(futureIds[n]);
 assert.equal(status(futureIds[5]),'open','latest resolved future member is not whole-group proof');
 for(const n of [1,2,3]) resolve(futureIds[n]);
 assert.equal(status(futureIds[5]),'resolved','final earlier member closes future group');
 console.log('PASS common source: legacy and versioned six-member admission groups preserve aggregation and close only after all six resolve');
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
 // An invalid cross-source member is retained as unknown, never a direct-mirror shortcut.
 const alien='51111111-1111-4111-8111-000000000001';
 sql(`INSERT INTO financial_alerts(id,severity,source,message,resolved) VALUES('${alien}','critical','fixture.alien','isolated alien',true);
 UPDATE financial_alerts SET resolved=false WHERE id='${alien}';
 SELECT fn_ca_raise_drift_incident(p_source=>'financial_alerts:${genericSource}',p_classification=>'unknown',p_severity=>'critical',
 p_dedupe_key=>'fa:${genericSource}:'||md5(fn_ca_normalize_alert_text('isolated unknown member')||'|'||fn_ca_normalize_alert_text('')),
 p_suspected_cause=>'isolated unknown member',p_metadata=>jsonb_build_object('alert_id','${alien}'));`);
 resolve(alien); assert.equal(status(alien),'open','wrong-source member cannot close through metadata direct-mirror fallback');
 assert.equal(sql(`SELECT detail->'financial_member_version'='1'::jsonb AND detail->'alert_id'='null'::jsonb FROM ca_incident_events WHERE incident_id=(SELECT id FROM ca_drift_incidents WHERE metadata->>'alert_id'='${alien}') AND kind='created'`),'t','invalid member identity is explicitly unknown in original event');
 // Legacy events sharing a timestamp with multiple matching originals are ambiguous.
 const amb1='61111111-1111-4111-8111-000000000001',amb2='61111111-1111-4111-8111-000000000002';
 sql(`BEGIN;INSERT INTO financial_alerts(id,severity,source,message,context,resolved) VALUES
 ('${amb1}','critical','${sourceName}','ambiguous legacy hand #900031','{"error":"ambiguous legacy"}',true),
 ('${amb2}','critical','${sourceName}','ambiguous legacy hand #900032','{"error":"ambiguous legacy"}',true);
 UPDATE financial_alerts SET resolved=false WHERE id IN('${amb1}','${amb2}');
 INSERT INTO ca_drift_incidents(source,dedupe_key,occurrences,metadata,detected_at,last_seen_at)
 SELECT 'financial_alerts:'||source,'fa:'||source||':'||md5(fn_ca_normalize_alert_text(left(message,200))||'|'||fn_ca_normalize_alert_text(left(context->>'error',200))),
 2,jsonb_build_object('alert_id',id),created_at,created_at FROM financial_alerts WHERE id='${amb2}';
 INSERT INTO ca_incident_events(incident_id,kind,detail)
 SELECT i.id,k.kind,jsonb_build_object('source',i.source) FROM ca_drift_incidents i CROSS JOIN(VALUES('created'),('recurred'))k(kind) WHERE i.metadata->>'alert_id'='${amb2}';COMMIT;`);
 resolve(amb1);resolve(amb2);assert.equal(status(amb2),'open','ambiguous legacy original membership never authorizes closure');
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
 // Concurrent first observations must retain both exact members after INSERT conflict.
 const r1='71111111-1111-4111-8111-000000000001',r2='71111111-1111-4111-8111-000000000002';
 const creator=client();creator.p.stdin.write('BEGIN;'+genericInsert(r1,0)+'\\echo CREATOR_READY\n');
 let creatorReady=false;const creatorUntil=Date.now()+5000;
 while(Date.now()<creatorUntil){if(sql(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query LIKE '%${r1}%'`) === '1'){creatorReady=true;break;}await new Promise(r=>setTimeout(r,20));}
 assert.ok(creatorReady,'first observation owns an uncommitted cause-group insert');
 const contender=client();contender.p.stdin.end(genericInsert(r2,1));
 let insertBlocked=false;const insertUntil=Date.now()+3000;
 while(Date.now()<insertUntil){if(sql(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%${r2}%'`) === '1'){insertBlocked=true;break;}await new Promise(r=>setTimeout(r,20));}
 assert.ok(insertBlocked,'second first observation actually waits on original insert');
 creator.p.stdin.end('COMMIT;\n');await Promise.all([creator.done,contender.done]);
 assert.equal(sql(`SELECT occurrences FROM ca_drift_incidents WHERE metadata->>'alert_id'='${r2}'`),'2','insert-conflict recurrence remains counted');
 assert.equal(sql(`SELECT count(*)=2 AND count(DISTINCT detail->>'alert_id')=2 FROM ca_incident_events WHERE incident_id=(SELECT id FROM ca_drift_incidents WHERE metadata->>'alert_id'='${r2}') AND kind IN('created','recurred')`),'t','concurrent insert fallback retains both exact original member UUIDs');
 resolve(r2);assert.equal(status(r2),'open');resolve(r1);assert.equal(status(r2),'resolved','insert-race members retain complete closure wiring');
 console.log('PASS observed concurrent original insertion conflict retains every member and exact closure');
 assert.equal(sql('SELECT count(*) FROM ca_incident_file_failures'),'0','no swallowed trigger failure');
 console.log('PASS after: table/hand boundaries, same-original recurrence, unknown identity, exact closure and unchanged history');
 console.log(sql("SELECT proname,md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid IN('fn_ca_financial_alert_to_incident()'::regprocedure,'fn_ca_alert_resolution_reaches_the_incident()'::regprocedure,'fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure) ORDER BY proname"));
} finally {
 for (const p of clients) if (p.exitCode === null) p.kill('SIGKILL');
 if (running) run('pg_ctl', ['-D', path.join(dir,'db'), '-m','immediate','-w','stop']);
 rmSync(dir, { recursive:true, force:true });
}
