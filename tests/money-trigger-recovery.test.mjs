import { test } from 'node:test';
import assert from 'node:assert/strict';
import {verifyRecovery,sha256} from '../scripts/ci/money-trigger-recovery.mjs';
const sql='CREATE TRIGGER guard BEFORE INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION f();';
function fixture(){const p={path:'supabase/migrations/20260101000000_old.sql',review:'independent-reviewed-test-fixture',originalVersion:'20260101000000',originalName:'old',originalSha256:sha256(sql),declarationVersion:'20260102000000',declarationName:'declare',declarationSha256:sha256('declaration sql'),triggers:[{table:'table_seats',trigger:'guard',definitionSha256:'c'.repeat(64),functionSha256:'d'.repeat(64),note:'Reviewed late declaration with exact installed authority.'}]};return {path:p.path,sql,files:{'supabase/migrations/20260102000000_declare.sql':'declaration sql'},policy:[p],headSha:'a'.repeat(40),now:1000000,live:{version:1,observed_at:new Date(1000000).toISOString(),history:[{version:p.originalVersion,name:'old',statementCount:1,sha256:p.originalSha256},{version:p.declarationVersion,name:'declare',statementCount:1,sha256:p.declarationSha256}],triggers:[{...p.triggers[0],enabled:'O'}],declarations:[p.triggers[0]]}}}
test('exact applied historical recovery passes',()=>assert.equal(verifyRecovery(fixture()).recovered,true));
for(const [name,mutate] of Object.entries({
 'new unreviewed trigger':x=>x.policy=[],
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
