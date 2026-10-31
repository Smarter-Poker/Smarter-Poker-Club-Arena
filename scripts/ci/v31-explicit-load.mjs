#!/usr/bin/env node
/** One explicit data-store load or same-identity status read. No release or promotion. */
import {readFileSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {assertClubArenaRepository} from './repository-identity.mjs';
const SHA=/^[0-9a-f]{40}$/,HEX=/^[0-9a-f]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const need=(ok,label)=>{if(!ok)throw Error(label);};
export function request(encoded){
 need(typeof encoded==='string'&&encoded.length<=2048&&/^[A-Za-z0-9+/=]+$/.test(encoded),'Bounded canonical request required');
 const bytes=Buffer.from(encoded,'base64');need(bytes.toString('base64')===encoded,'Canonical request encoding required');
 const p=JSON.parse(bytes.toString('utf8'));need(bytes.toString('utf8')===JSON.stringify(p),'Canonical compact request JSON required');
 need(exact(p,['operation','sourceSha','requestId','datasetId','checksum','cellCount','workerCount'])&&['reload','status'].includes(p.operation)&&SHA.test(p.sourceSha)&&p.sourceSha!=='0'.repeat(40)&&UUID.test(p.requestId)&&UUID.test(p.datasetId)&&HEX.test(p.checksum)&&p.checksum!=='0'.repeat(64)&&p.cellCount===107&&p.workerCount===8,'Exact complete R7 store identity required');return p;
}
export function invocation(env){
 assertClubArenaRepository(env.GITHUB_REPOSITORY,env.GITHUB_REPOSITORY_ID);
 need(env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_REF==='refs/heads/main'&&env.GITHUB_RUN_ATTEMPT==='1','Explicit first-attempt protected-main operation required');
}
export function health(p,h,loaded){
 const live=h?.liveHorseDecision,s=live?.solverStores;
 need(h?.status==='ok'&&h.releaseSha===p.sourceSha&&live?.phase==='ready'&&live.workerCount===8,'Exact healthy eight-worker serving source required');
 if(loaded)need(s?.postflopV31===107&&s.postflopV31Dataset?.id===p.datasetId&&s.postflopV31Dataset?.checksum===p.checksum,'Exact loaded public215 store required');
}
export function receipt(p,v,now=Date.now()){
 need(exact(v,['format','operation','observedAt','sourceSha','receipt'])&&v.format==='v31_explicit_store_control_receipt_v1'&&v.operation===p.operation&&v.sourceSha===p.sourceSha,'Actual serving CLI receipt required');
 const age=now-Date.parse(v.observedAt);need(Number.isFinite(age)&&age>=-30000&&age<=300000,'Fresh actual control receipt required');
 const r=v.receipt;need(exact(r,['checksum','datasetId','expectedCells','requestId','state','workers'])&&r.checksum===p.checksum&&r.datasetId===p.datasetId&&r.requestId===p.requestId&&r.expectedCells===107&&r.state==='complete'&&Array.isArray(r.workers)&&r.workers.length===8,'Complete exact request outcome required');
 const seen=new Set();
 for(const a of r.workers){
  need(exact(a,['worker','type','operation','requestId','ok','count','dataset','error'])&&Number.isInteger(a.worker)&&a.worker>=0&&a.worker<=7&&!seen.has(a.worker)&&a.type==='V31_STORE_CONTROL_ACK'&&a.operation===p.operation&&a.requestId===p.requestId&&a.ok===true&&a.count===107&&a.error===null&&exact(a.dataset,['id','checksum'])&&a.dataset.id===p.datasetId&&a.dataset.checksum===p.checksum,'Eight distinct matching worker acknowledgments required');seen.add(a.worker);
 }
 return v;
}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function remoteCommand(p){
 // Validate again even when called independently of the workflow argument reader.
 p=request(Buffer.from(JSON.stringify(p)).toString('base64'));
 const code=`set -euo pipefail
test -f /var/lock/club-arena-engine-up.lock || { echo release_lock_missing >&2; exit 1; }
exec 9>/var/lock/club-arena-engine-up.lock
flock -n 9 || { echo release_lock_busy >&2; exit 75; }
clock=$(TZ=America/Chicago date +%H%M)
if [ "$clock" -ge 350 ] && [ "$clock" -le 406 ]; then echo daily_maintenance_owns_interval >&2; exit 75; fi
before=$(docker container inspect -f '{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.State.Status}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' club-arena-engine)
case "$before" in *'|running|${p.sourceSha}') ;; *) echo serving_image_mismatch >&2; exit 1;; esac
set +e
docker exec club-arena-engine node dist/scripts/reloadPublic215Stores.js ${p.operation} ${p.requestId} ${p.datasetId} ${p.checksum}
result_code=$?
set -e
after=$(docker container inspect -f '{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.State.Status}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' club-arena-engine)
[ "$before" = "$after" ] || { echo serving_identity_changed >&2; exit 1; }
exit "$result_code"`;
 return 'bash -c '+quote(code);
}
function readJson(path){need(statSync(path).size<=1048576,'Bounded control metadata required');return JSON.parse(readFileSync(path,'utf8'));}
function main(){
 invocation(process.env);const [mode,encoded,file,...extra]=process.argv.slice(2),p=request(encoded);need(!extra.length,'Exact CLI arguments required');
 if(mode==='--validate'){need(file===undefined,'Exact CLI arguments required');console.log('V31_EXPLICIT_REQUEST_VALID');}
 else if(mode==='--remote-command'){need(file===undefined,'Exact CLI arguments required');console.log(remoteCommand(p));}
 else if(mode==='--health-before'||mode==='--health-after')health(p,readJson(file),mode==='--health-after');
 else if(mode==='--receipt')console.log(JSON.stringify(receipt(p,readJson(file))));
 else throw Error('Explicit control mode required');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{main();}catch{console.error('V31_EXPLICIT_CONTROL_UNVERIFIED_INSPECT_SAME_REQUEST');process.exitCode=1;}
