import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {request,invocation,health,receipt,remoteCommand} from './v31-explicit-load.mjs';
const p={operation:'reload',sourceSha:'a'.repeat(40),requestId:'11111111-1111-4111-8111-111111111111',datasetId:'22222222-2222-4222-8222-222222222222',checksum:'b'.repeat(64),cellCount:107,workerCount:8};
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64');
const env={GITHUB_REPOSITORY:'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',GITHUB_REPOSITORY_ID:'1132369872',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1'};
const h=()=>({status:'ok',releaseSha:p.sourceSha,liveHorseDecision:{phase:'ready',workerCount:8,solverStores:{postflopV31:107,postflopV31Dataset:{id:p.datasetId,checksum:p.checksum}}}});
const good=(operation='reload')=>({format:'v31_explicit_store_control_receipt_v1',operation,sourceSha:p.sourceSha,observedAt:new Date().toISOString(),receipt:{requestId:p.requestId,datasetId:p.datasetId,checksum:p.checksum,expectedCells:107,state:'complete',workers:Array.from({length:8},(_,worker)=>({worker,type:'V31_STORE_CONTROL_ACK',operation,requestId:p.requestId,ok:true,count:107,dataset:{id:p.datasetId,checksum:p.checksum},error:null}))}});
test('only a bounded complete identity and first explicit protected operation are admitted',()=>{
 assert.deepEqual(request(encode(p)),p);invocation(env);
 for(const patch of [{operation:'promote'},{cellCount:1},{workerCount:7},{sourceSha:'unsafe;cmd'},{requestId:'bad'},{checksum:'0'.repeat(64)},{extra:true}])assert.throws(()=>request(encode({...p,...patch})));
 assert.throws(()=>request(encode(p)+'='));assert.throws(()=>request(Buffer.from(JSON.stringify(p).replace('{','{\"operation\":\"status\",')).toString('base64')));
 for(const patch of [{GITHUB_EVENT_NAME:'schedule'},{GITHUB_REF:'refs/heads/feature'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_REPOSITORY_ID:'1'}])assert.throws(()=>invocation({...env,...patch}));
});
test('actual load and same-identity fresh status each require all eight original acknowledgments',()=>{
 assert.equal(receipt(p,good()).receipt.workers.length,8);assert.equal(receipt({...p,operation:'status'},good('status')).operation,'status');
 for(const edit of [v=>v.receipt.workers.pop(),v=>v.receipt.workers[1].worker=0,v=>v.receipt.workers[0].ok=false,v=>v.receipt.workers[0].count=106,v=>v.receipt.workers[0].operation='status',v=>v.receipt.state='partial',v=>v.sourceSha='c'.repeat(40),v=>v.receipt.workers[0].dataset.checksum='c'.repeat(64),v=>v.observedAt='2020-01-01T00:00:00Z']){const v=good();edit(v);assert.throws(()=>receipt(p,v));}
});
test('before requires eight healthy serving workers and after additionally proves exact loaded identity',()=>{
 health(p,h(),true);const before=h();before.liveHorseDecision.solverStores={};health(p,before,false);assert.throws(()=>health(p,before,true));
 for(const edit of [v=>v.releaseSha='c'.repeat(40),v=>v.liveHorseDecision.workerCount=7,v=>v.liveHorseDecision.solverStores.postflopV31=106]){const v=h();edit(v);assert.throws(()=>health(p,v,true));}
});
test('fixed provider invocation preserves the live container and cannot build, promote or restart',()=>{
 const c=remoteCommand(p);
 for(const s of ['flock -n 9','TZ=America/Chicago','reloadPublic215Stores.js reload','result_code=$?','"$before" = "$after"'])assert.ok(c.includes(s));
 assert.ok(remoteCommand({...p,operation:'status'}).includes('reloadPublic215Stores.js status'));
 assert.doesNotMatch(c,/docker (?:run|build|pull|restart|stop|rm)|systemctl|--env-file|Config.Env|\.env|promot/);
 assert.throws(()=>remoteCommand({...p,checksum:'unsafe;command'}));
 const w=readFileSync(new URL('../../.github/workflows/v31-explicit-load.yml',import.meta.url),'utf8');
 assert.match(w,/workflow_dispatch:/);assert.match(w,/GITHUB_RUN_ATTEMPT/);assert.match(w,/--health-after/);assert.match(w,/StrictHostKeyChecking=yes/);
 assert.doesNotMatch(w,/schedule:|workflow_run:|repository_dispatch:|continue-on-error:|cancel-in-progress: true/);
});
