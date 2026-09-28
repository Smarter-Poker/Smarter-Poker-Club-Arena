import { test } from 'node:test';
import assert from 'node:assert/strict';
import {verifyRecovery,sha256,recordedStatementCandidates} from '../scripts/ci/money-trigger-recovery.mjs';
const sql='CREATE TRIGGER guard BEFORE INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION f();';
function fixture(){const p={path:'supabase/migrations/20260101000000_old.sql',review:'independent-reviewed-test-fixture',originalVersion:'20260101000000',originalName:'old',originalSha256:sha256(sql),declarationVersion:'20260102000000',declarationName:'declare',declarationSha256:sha256('declaration sql'),triggers:[{table:'table_seats',trigger:'guard',definitionSha256:'c'.repeat(64),functionSha256:'d'.repeat(64),note:'Reviewed late declaration with exact installed authority.'}]};return {path:p.path,sql,files:{'supabase/migrations/20260102000000_declare.sql':'declaration sql'},policy:[p],headSha:'a'.repeat(40),now:1000000,live:{version:1,observed_at:new Date(1000000).toISOString(),history:[{version:p.originalVersion,name:'old',statementCount:1,sha256:p.originalSha256},{version:p.declarationVersion,name:'declare',statementCount:1,sha256:p.declarationSha256}],triggers:[{...p.triggers[0],enabled:'O'}],declarations:[p.triggers[0]]}}}
test('exact applied historical recovery passes',()=>assert.equal(verifyRecovery(fixture()).recovered,true));
for(const [name,mutate] of Object.entries({
 // A NEW trigger has no applied history. (With history, byte-identical SQL and a live declaration it is a recording; see below.)
 'new unreviewed trigger':x=>{x.policy=[];x.live.history=x.live.history.filter(h=>h.version!=='20260101000000')},
 'unreviewed trigger whose applied SQL differs':x=>{x.policy=[];x.live.history[0].sha256='e'.repeat(64)},
 'missing candidate declaration file':x=>x.files={},
 'changed candidate declaration bytes':x=>x.files['supabase/migrations/20260102000000_declare.sql']='changed',
 'pending declaration':x=>x.live.history.pop(),
 'local receipt cannot replace live':x=>x.live=null,
 'changed historical bytes':x=>x.sql+='\n-- altered',
 'third trigger':x=>{x.sql+='\nCREATE TRIGGER extra BEFORE INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION f();';x.policy[0].originalSha256=sha256(x.sql);x.live.history[0].sha256=sha256(x.sql)},
 'wrong table':x=>x.live.triggers[0].table='wallets',
 'wrong registry note':x=>x.live.declarations=[{...x.live.declarations[0],note:'changed'}],
 'missing registry':x=>x.live.declarations=[],
 'changed function':x=>x.live.triggers[0].functionSha256='e'.repeat(64),
 'disabled trigger':x=>x.live.triggers[0].enabled='D',
 'stale proof':x=>x.now+=300001,
 'wrong installed SQL':x=>x.live.history[0].sha256='e'.repeat(64),
 'duplicate history':x=>x.live.history.push(x.live.history[0])
})){test(name+' refuses',()=>{const x=fixture();mutate(x);assert.throws(()=>verifyRecovery(x))})}
test('ordinary same-file declaration still passes without recovery',()=>{const x=fixture();x.policy=[];x.live=null;x.sql+="\nINSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES('table_seats','guard','reviewed guard');";assert.equal(verifyRecovery(x).recovered,false)});

// 2026-09-28: a byte-exact recording of an applied migration is proved from the live catalogue, not a contract.
function recording(form){const v='20260420005652',stmt=sql;const text=form==='legacy'?`-- BACKFILLED 2026-09-28 from supabase_migrations.schema_migrations.statements.\n-- header\n--\n${stmt}\n`:stmt;return {path:`supabase/migrations/${v}_guard.sql`,sql:text,files:{},policy:[],headSha:'a'.repeat(40),now:1000000,live:{version:1,observed_at:new Date(1000000).toISOString(),history:[{version:v,name:'guard',statementCount:1,sha256:sha256(stmt)}],triggers:[{table:'table_seats',trigger:'guard',enabled:'O'}],declarations:[{table:'table_seats',trigger:'guard',note:'declared'}]}}}
test('headerless recording of applied SQL passes',()=>assert.equal(verifyRecovery(recording('plain')).recording,true));
test('legacy BACKFILLED recording of applied SQL passes',()=>assert.equal(verifyRecovery(recording('legacy')).recording,true));
test('recording whose trigger was later dropped passes and says so',()=>{const x=recording('plain');x.live.triggers=[];x.live.declarations=[];assert.deepEqual(verifyRecovery(x).triggersNoLongerLive,['table_seats.guard'])});
for(const [name,mutate] of Object.entries({
 'recording of a live undeclared trigger':x=>x.live.declarations=[],
 'recording with edited SQL':x=>x.sql=x.sql.replace('guard BEFORE','guard AFTER'),
 'recording whose version production does not hold':x=>x.live.history=[],
 'recording of a multi-statement row':x=>x.live.history[0].statementCount=2,
 'recording without live proof':x=>x.live=null,
 'new migration under an unapplied version':x=>x.path='supabase/migrations/20990101000000_guard.sql',
 'header that is not the legacy marker':x=>{x.sql='-- not a recording\n'+x.sql+'\n'},
})){test(name+' refuses',()=>{const x=recording('plain');mutate(x);assert.throws(()=>verifyRecovery(x))})}
test('only a leading comment block is ever stripped',()=>{assert.deepEqual(recordedStatementCandidates('SELECT 1;\n'),['SELECT 1;\n'])});
