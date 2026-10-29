#!/usr/bin/env node
/** Explicit finite evidence collection from an already staged image. No builds or activation. */
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertClubArenaRepository} from './repository-identity.mjs';
import {servingIdentity} from './gto-v31-qualification.mjs';
const SHA=/^[0-9a-f]{40}$/,HEX=/^[0-9a-f]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DB='https://kuklfnapbkmacvwxktbh.supabase.co';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('\0')===[...keys].sort().join('\0');
const requireValue=(ok,label)=>{if(!ok)throw Error(label);};
export function canonical(v){if(v===null||typeof v==='boolean')return JSON.stringify(v);if(typeof v==='string'&&/^[\x20-\x7e]*$/.test(v))return JSON.stringify(v);if(typeof v==='number'&&Number.isSafeInteger(v)&&!Object.is(v,-0))return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>canonical(k)+':'+canonical(v[k])).join(',')+'}';throw Error('Noncanonical public model metadata');}
export const digest=v=>createHash('sha256').update(canonical(v),'ascii').digest('hex');
export function invocation(env,event){
 assertClubArenaRepository(env.GITHUB_REPOSITORY,env.GITHUB_REPOSITORY_ID);
 requireValue(env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_REF==='refs/heads/main','Explicit protected-main dispatch required');
 const p=event.inputs;
 requireValue(exact(p,['dataset','candidate_sha','image_id','stage_run'])&&UUID.test(p.dataset)&&SHA.test(p.candidate_sha)&&/^sha256:[0-9a-f]{64}$/.test(p.image_id)&&/^[1-9][0-9]*$/.test(p.stage_run),'Exact staged-image selection required');
 return p;
}
export function stageAdmission(run,jobs,sha){
 requireValue(run?.path==='.github/workflows/auto-deploy-hetzner.yml'&&run.event==='repository_dispatch'&&run.head_branch==='main'&&run.display_title===`Engine Release ${sha}`,'Existing exact release run required');
 const required=[...Array.from({length:4},(_,i)=>`Test The Exact Engine Release Request (shard ${i+1}/4)`),'Prove The Exact Engine Has Every Production Door'];
 for(const name of required){const matches=jobs.filter(j=>j.name===name);requireValue(matches.length===1&&matches[0].status==='completed'&&matches[0].conclusion==='success',`Existing source admission incomplete: ${name}`);}
}
export const GRAPH_FILES=Object.freeze(['server/src/engine/GtoPublicHist215Features.ts','server/src/engine/GtoPublicHist215FeatureSchema.ts','server/src/engine/GtoPublicHist215FeatureDescriptor.json','server/src/engine/GtoBoardRelativeFeaturesV1.ts','server/src/engine/GtoBoardRelativeFeaturesV2.ts','server/src/engine/GtoPublicHist215Model.ts','server/native/public_hist215_wtl.cc','server/scripts/build-public-hist215-native.mjs','server/src/scripts/buildPublicHist215Features.ts','server/scripts/prepare-public215-feature-request.py']);
export function sourceGraph(descriptor,expected,readCommitted){
 requireValue(exact(descriptor,['format','files'])&&descriptor.format==='public_hist215_encoder_source_graph_v1'&&digest(descriptor)===expected&&Array.isArray(descriptor.files)&&descriptor.files.length===10,'Approved complete encoder graph required');
 const seen=new Set();
 for(const f of descriptor.files){
  requireValue(exact(f,['path','sha256'])&&typeof f.path==='string'&&f.path.startsWith('/')&&!f.path.split('/').includes('..')&&HEX.test(f.sha256),'Canonical approved source graph file required');
  const marker=f.path.lastIndexOf('/server/');const relative=marker<0?'':f.path.slice(marker+1);
  requireValue(GRAPH_FILES.includes(relative)&&!seen.has(relative),'Closed encoder graph path required');seen.add(relative);
  requireValue(createHash('sha256').update(readCommitted(relative)).digest('hex')===f.sha256,'Candidate bytes differ from approved encoder graph');
 }
}
export function programRequest(row,dataset){
 const keys=['context','policy_representation','public_model','public_template','public_training_provenance','model_checksum','template_checksum','feature_schema_checksum','training_provenance_checksum'];
 requireValue(row?.dataset_id===dataset&&row.policy_representation==='public_hist215_v1'&&row.status==='prepared','One private unqualified preparation required');
 const program=Object.fromEntries(keys.map(k=>[k,row[k]])),p=program.public_training_provenance;
 for(const [field,sha]of [['public_model','model_checksum'],['public_template','template_checksum'],['public_training_provenance','training_provenance_checksum']])requireValue(digest(program[field])===program[sha],'Immutable private program digest differs');
 requireValue(digest(row.runtime_parity_protocol)===p.runtime_parity_protocol_checksum&&digest(row.encoder_descriptor)===p.encoder_checksum,'Approved public protocol/source binding differs');
 requireValue(canonical(program.public_template.context)===canonical(row.context)&&program.public_model.template_sha256===program.template_checksum&&program.public_model.provenance_sha256===program.training_provenance_checksum&&program.public_model.feature_schema_sha256===program.feature_schema_checksum,'Prepared program crossbinding differs');
 const groups=row.runtime_parity_protocol.contexts.filter(g=>canonical(g.context)===canonical(row.context));
 requireValue(groups.length===1&&Array.isArray(groups[0].cases)&&groups[0].cases.length>=2&&groups[0].cases.length<=32,'Exact approved public cases required');
 const request={format:'public_hist215_preflight_request_v1',dataset_id:dataset,program,cases:groups[0].cases};
 requireValue(Buffer.byteLength(canonical(request),'ascii')<=4*1024*1024,'Existing 4 MiB request ceiling exceeded');return request;
}
export function remoteCommand(sha,image,tree,requestSha,runKey){
 requireValue(SHA.test(sha)&&/^sha256:[0-9a-f]{64}$/.test(image)&&SHA.test(tree)&&HEX.test(requestSha)&&/^[1-9][0-9]*-[1-9][0-9]*$/.test(runKey),'Immutable host invocation required');
 const script=`set -euo pipefail
exec 9>/var/lock/club-arena-engine-up.lock
flock -n 9 || { echo 'Existing release lock is busy' >&2; exit 75; }
# Do not occupy the engine lock near the existing daily last-hand/cutover interval.
clock=$(TZ=America/Chicago date +%H%M)
if [ "$clock" -ge 350 ] && [ "$clock" -le 406 ]; then echo 'Daily engine maintenance owns this interval' >&2; exit 75; fi
before=$(docker container inspect -f '{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.State.Status}}|{{index .Config.Labels "sp.release.sha"}}' club-arena-engine)
case "$before" in *'|running|'*) ;; *) echo 'Serving engine is not running' >&2; exit 1;; esac
[ "$(docker image inspect -f '{{.Id}}' ${image})" = '${image}' ]
[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ${image})" = '${sha}' ]
[ "$(docker image inspect -f '{{index .Config.Labels "com.smarterpoker.engine.source-tree"}}' ${image})" = '${tree}' ]
[ "$(docker image inspect -f '{{index .Config.Labels "com.smarterpoker.engine.build-contract"}}' ${image})" = 'clean-server-archive-v1' ]
name='public215-preflight-${runKey}-${requestSha.slice(0,16)}'
if docker container inspect "$name" >/dev/null 2>&1; then echo 'Owned finite context already exists; inspect its outcome' >&2; exit 1; fi
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
set +e
output=$(timeout --signal=TERM --kill-after=5s 300s docker run --rm -i --name "$name" --pull=never --network none --read-only --cap-drop ALL --security-opt no-new-privileges --cpus .5 --memory 512m --pids-limit 64 --user node --entrypoint node '${image}' dist/scripts/public215ModelPreflight.js '${requestSha}')
result_code=$?
set -e
after=$(docker container inspect -f '{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.State.Status}}|{{index .Config.Labels "sp.release.sha"}}' club-arena-engine)
[ "$before" = "$after" ] || { echo 'Serving engine identity changed' >&2; exit 1; }
[ "$result_code" -eq 0 ] || exit "$result_code"
printf '%s\\n' "$output"`;
 return 'bash -c '+"'"+script.replaceAll("'","'\\''")+"'";
}
export function executionEvidence(result,metadata,write){
 requireValue(exact(result,['format','receipt','receipt_checksum','execution_ms_f64','peak_rss_bytes'])&&result.format==='public_hist215_preflight_result_v1','Exact actual Linux stdout shape required');
 requireValue(metadata.exit_code===0&&HEX.test(metadata.context_id)&&HEX.test(metadata.request_sha256)&&SHA.test(metadata.candidate_sha)&&/^sha256:[0-9a-f]{64}$/.test(metadata.image_id),'Actual successful context terminal metadata required');
 write(metadata.context_id+'.result.json',canonical(result)+'\n');
 // This terminal witness is published only after actual SSH and Docker exit0,
 // complete shape/hash admission and durable result-file creation.
 write(metadata.context_id+'.exit.json',canonical(metadata)+'\n');
}

function writeEvidence(out,name,bytes){
 const file=openSync(join(out,name),'wx',0o600);
 try{writeFileSync(file,bytes);fsyncSync(file);}finally{closeSync(file);}
 const directory=openSync(out,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}

function command(binary,args,options={}){const r=spawnSync(binary,args,{encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024,...options});requireValue(!r.error&&r.status===0,`Finite command failed: ${binary.split('/').pop()}`);return options.encoding===null?r.stdout:r.stdout.trim();}
async function rpc(name,args){requireValue(process.env.SUPABASE_URL===DB&&process.env.SUPABASE_SERVICE_ROLE_KEY,'Canonical configured SQL identity required');const key=process.env.SUPABASE_SERVICE_ROLE_KEY;const response=await fetch(DB+'/rest/v1/rpc/'+name,{method:'POST',signal:AbortSignal.timeout(30000),headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(args)});requireValue(response.ok,'Private preparation metadata unavailable');const text=await response.text();requireValue(Buffer.byteLength(text)<=8*1024*1024,'Bounded preparation metadata required');return JSON.parse(text);}
async function healthy(){const r=await fetch('https://engine.smarter.poker/health?public215-preflight='+Date.now(),{signal:AbortSignal.timeout(15000)});requireValue(r.ok,'Healthy engine unavailable');return servingIdentity(await r.json());}
async function main(){
 const selected=invocation(process.env,JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')));
 const repo=process.cwd(),out=resolve(process.env.PUBLIC215_RECEIPT_DIR||'artifacts/public215-linux-preflight');mkdirSync(out,{recursive:true,mode:0o700});
 command('git',['merge-base','--is-ancestor',selected.candidate_sha,'origin/main']);
 const tree=command('git',['rev-parse',selected.candidate_sha+':server']);
 const run=JSON.parse(command('gh',['api',`repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${selected.stage_run}`]));
 const pages=JSON.parse(command('gh',['api','--paginate','--slurp',`repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${selected.stage_run}/jobs?per_page=100`]));stageAdmission(run,pages.flatMap(p=>p.jobs),selected.candidate_sha);
 const before=await healthy();let count=0;const observed=new Set();let after;
 try {
 for(let offset=0;offset<=1024;offset++){
  const page=await rpc('fn_gto_v31_model_preparations',{p_dataset_id:selected.dataset,p_offset:offset,p_limit:1});requireValue(Array.isArray(page)&&page.length<=1,'One private preparation page required');if(!page.length)break;
  const row=page[0],request=programRequest(row,selected.dataset),cid=digest(row.context);requireValue(!observed.has(cid),'Duplicate private preparation');observed.add(cid);
  sourceGraph(row.encoder_descriptor,row.public_training_provenance.encoder_checksum,path=>Buffer.from(command('git',['show',selected.candidate_sha+':'+path],{encoding:null})));
  const bytes=canonical(request),requestSha=createHash('sha256').update(bytes,'ascii').digest('hex');
  const result=JSON.parse(command(process.env.PUBLIC215_SSH_COMMAND,[remoteCommand(selected.candidate_sha,selected.image_id,tree,requestSha,process.env.GITHUB_RUN_ID+'-'+process.env.GITHUB_RUN_ATTEMPT)],{input:bytes,timeout:330000}));
  requireValue(result?.format==='public_hist215_preflight_result_v1'&&digest(result.receipt)===result.receipt_checksum&&result.receipt.model_checksum===row.model_checksum&&result.receipt.dataset_id===selected.dataset,'Actual finite Linux result binding differs');
  executionEvidence(result,{exit_code:0,context_id:cid,request_sha256:requestSha,candidate_sha:selected.candidate_sha,image_id:selected.image_id,stage_run:selected.stage_run,observedAt:new Date().toISOString()},(name,bytes)=>writeEvidence(out,name,bytes));count++;
 }
 requireValue(count===107,'Complete 107-context private preparation set required');
 } finally {
  after=await healthy();writeFileSync(join(out,'serving-identity.json'),canonical({serving_sha_before:before.releaseSha,serving_sha_after:after.releaseSha,contexts:count})+'\n',{flag:'wx',mode:0o600});requireValue(before.releaseSha===after.releaseSha,'Healthy serving identity changed');
 }
 writeFileSync(join(out,'receipt.json'),canonical({format:'public215_linux_preflight_control_v1',dataset_id:selected.dataset,candidate_sha:selected.candidate_sha,image_id:selected.image_id,stage_run:selected.stage_run,contexts:count,serving_sha_before:before.releaseSha,serving_sha_after:after.releaseSha,status:'execution_evidence_only_not_frozen_or_certified'})+'\n',{flag:'wx',mode:0o600});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{const out=resolve(process.env.PUBLIC215_RECEIPT_DIR||'artifacts/public215-linux-preflight');mkdirSync(out,{recursive:true,mode:0o700});writeFileSync(join(out,'failure.json'),canonical({format:'public215_linux_preflight_failure_v1',status:'incomplete_unqualified_no_freeze_or_activation'})+'\n',{mode:0o600});console.error('Finite public215 Linux preflight refused; retained evidence is incomplete and unqualified');process.exitCode=1;});
