import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const {Client}=createRequire(new URL('../server/package.json',import.meta.url))('pg');
import {fixtureSql,migrationSql,refundTriggersSql,sourceHashes} from './qualification/stable-admin-cancel-stops/fixture.mjs';
import {qualify,actor,chip} from './qualification/stable-admin-cancel-stops/assertions.mjs';
const bins=[process.env.STABLE_CANCEL_POSTGRES_BIN,'/opt/homebrew/opt/postgresql@17/bin','/usr/lib/postgresql/17/bin'].filter(Boolean);
const bin=bins.find(p=>fs.existsSync(path.join(p,'initdb')));
assert.ok(bin,'Native PostgreSQL17 is required');
assert.match(execFileSync(path.join(bin,'postgres'),['--version'],{encoding:'utf8'}),/\b17\./);
const scratch=process.env.TMPDIR;
assert.ok(scratch&&(process.platform!=='darwin'||scratch.startsWith('/Volumes/SmarterWork/agent-work/')),'External SSD task scratch is required on Mac');
fs.mkdirSync(scratch,{recursive:true});const work=fs.mkdtempSync(path.join(scratch,'cancel-stop-pg17-'));
const username=execFileSync('id',['-un'],{encoding:'utf8'}).trim();
const port=55457;const clients=[];let started=false;
const hashes=sourceHashes();
try {
 execFileSync(path.join(bin,'initdb'),['-D',work+'/data','-A','trust','-U',username],{stdio:'pipe'});
 execFileSync(path.join(bin,'pg_ctl'),['-D',work+'/data','-l',work+'/postgres.log','-o',`-h 127.0.0.1 -k '' -p ${port}`,'-w','start'],{stdio:'pipe'});started=true;
 const connect=async()=>{const c=new Client({host:'127.0.0.1',port,user:username,database:'postgres',options:'-c statement_timeout=20000 -c lock_timeout=10000',query_timeout:25000});await c.connect();clients.push(c);return c;};
 const db=await connect();await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF; END $$; SET ROLE postgres");
 await db.query(fixtureSql());await db.query(migrationSql());await db.query(fs.readFileSync(new URL('./qualification/stable-admin-cancel-stops/opening.sql',import.meta.url),'utf8'));await db.query(refundTriggersSql());
 const query=async sql=>{const r=await db.query(sql);return Array.isArray(r)?r.at(-1):r;};
 const result=await qualify(query);
 const first=await connect(),second=await connect();
 const waitBlocked=async client=>{for(let attempt=0;attempt<100;attempt++){const r=await db.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) blocked',[client.processID]);if(r.rows[0].blocked)return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Expected real-session lock wait did not occur');};
 // An operation admitted first retains the shared path lock through commit.
 await first.query('BEGIN');await first.query("SELECT fn_ca_assert_emergency_path('tournament_registration')");
 const stop="SELECT fn_ca_set_emergency_stop('tournament_registration',true,0,'Qualification race reason','90000000-0000-4000-8000-000000000011','"+actor+"','qualification') result";
 let settled=false;const stopping=second.query(stop).then(r=>{settled=true;return r;});
 await waitBlocked(second);assert.equal(settled,false);await first.query('COMMIT');assert.equal((await stopping).rows[0].result.ok,true);
 // A new admission observes committed stop state; no stale statement bypass.
 await assert.rejects(first.query("SELECT fn_ca_assert_emergency_path('tournament_registration')"),e=>e.code==='P0410');
 await db.query("SELECT fn_ca_set_emergency_stop('tournament_registration',false,1,'Qualification release reason','90000000-0000-4000-8000-000000000012','"+actor+"','qualification')");
 await first.query('BEGIN');await first.query("SELECT fn_ca_set_emergency_stop('tournament_registration',true,2,'Qualification race reason','90000000-0000-4000-8000-000000000013','"+actor+"','qualification')");
 const admission=second.query("SELECT fn_ca_assert_emergency_path('tournament_registration')");
 // Attach rejection handler before releasing the stop transaction.
 const refused=assert.rejects(admission,e=>e.code==='P0410');await waitBlocked(second);await first.query('COMMIT');await refused;
 await db.query("SELECT fn_ca_set_emergency_stop('tournament_registration',false,3,'Qualification release reason','90000000-0000-4000-8000-000000000014','"+actor+"','qualification')");
 const cancel="SELECT fn_ca_operator_cancel_tournament('"+chip+"','60000000-0000-4000-8000-000000000099','Qualification concurrent refund','"+actor+"','qualification') result";
 const done=await Promise.all([first.query(cancel),second.query(cancel)]);
 assert.deepEqual(done[0].rows[0].result.receipt,done[1].rows[0].result.receipt);
 assert.equal(done.filter(r=>r.rows[0].result.replayed).length,1);
 assert.equal(Number((await db.query('SELECT count(*) count FROM tournament_refund_tranches')).rows[0].count),1);
 assert.deepEqual(sourceHashes(),hashes,'Qualification source changed during execution');
 console.log(JSON.stringify({backend:'native PostgreSQL17',...result,realSessionStopOrdering:true,realSessionDuplicateRefundExactlyOnce:true,sourceInputsStable:true,sourceHashes:hashes}));
} finally {
 for(const client of clients)await client.end();
 if(started){const stopped=spawnSync(path.join(bin,'pg_ctl'),['-D',work+'/data','-m','fast','-w','stop'],{encoding:'utf8'});assert.equal(stopped.status,0,'Cluster retained because shutdown failed');}
 if(started||!fs.existsSync(path.join(work,'data/postmaster.pid')))fs.rmSync(work,{recursive:true,force:true});
}
