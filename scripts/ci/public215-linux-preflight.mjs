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
export const RESOLVE_EXISTING_IMAGE='resolve-existing';
const IMAGE=/^sha256:[0-9a-f]{64}$/;
const DB='https://kuklfnapbkmacvwxktbh.supabase.co';
// Explicit reviewed handoff, not a search for a previous attempt or a retry policy.
// These six first-party Linux receipts already passed the independent full IEEE
// comparison; final assembly still requires all 107 original reference comparisons.
export const R7_RESUME_HANDOFF=Object.freeze({
 "format": "public215_explicit_resume_handoff_v1",
 "dataset": "2f9499d5-64de-456c-bbd7-97369cc6f48b",
 "candidate_sha": "3a3107e2690f234a032c54d752fd47275a5dd2c3",
 "stage_run": "40989073686",
 "image_id": "sha256:7087b1747609b29d7d9b6895373cb556df3a3cd52864fe16b8c305ccf47d5e19",
 "server_tree": "4d9c9b5ae0449a4803941a0ae9ef234da3da4089",
 "serving_sha": "eed06fe51dea622069c661a6213d5b031ff3a9e3",
 "predecessor": {
  "run_id": 41031099835,
  "attempt": 1,
  "head_sha": "ddfa6d4062904dfc629d28a4ed71e2823d7a7fb9",
  "contract_job": 123980773466,
  "evidence_job": 123980981865,
  "artifact_id": 12965363333,
  "artifact_name": "public215-linux-41031099835-1",
  "archive_bytes": 17440,
  "archive_sha256": "dc087fc87deb4e53a1923614bac01c79c6ace612c1a983d840b1278b5862d570"
 },
 "files": [
  {
   "name": "268f602ae7fe9bd334e053e34f8f046decf6ab0245610eeb2f373a54a2006525.exit.json",
   "bytes": 390,
   "sha256": "ddcb15974f058b91ba4fd851fe699406b23ce5c0bedc5f734f1e7091d5e58c68"
  },
  {
   "name": "268f602ae7fe9bd334e053e34f8f046decf6ab0245610eeb2f373a54a2006525.result.json",
   "bytes": 10646,
   "sha256": "3c365dc52257b7c170a73b9aea3e6a467b5da32d940d7b18accfb2c84042157c"
  },
  {
   "name": "934a91780ee861efe986fd0f987826ac51fbb6600ee45242c871bf1e9a1c172e.exit.json",
   "bytes": 390,
   "sha256": "1bf100b42bdda82dbce187e615cc402d046493b9e727f5d95edfbd50a03a5709"
  },
  {
   "name": "934a91780ee861efe986fd0f987826ac51fbb6600ee45242c871bf1e9a1c172e.result.json",
   "bytes": 10795,
   "sha256": "248c778c40f04dc42a5eec9654de632113eb78d83ef2bd9386bac26e5aff5f56"
  },
  {
   "name": "96f842c2c509cadf8392776e18c0b431fbcd372db381705d7ffec758a3880cf0.exit.json",
   "bytes": 390,
   "sha256": "4370a9aaa82664793ee5ff4729db42a049a77c7ad9abdf87160f1f6b4366636c"
  },
  {
   "name": "96f842c2c509cadf8392776e18c0b431fbcd372db381705d7ffec758a3880cf0.result.json",
   "bytes": 10650,
   "sha256": "36296119ee25163ca0a9381bb3e589166358f6cc1e70fba28aa77c9e74f7bf77"
  },
  {
   "name": "c79992c4bacd8e73c8c00c529bba40c1c21022a8061d73927843aabf12fce4d6.exit.json",
   "bytes": 390,
   "sha256": "53deda4eb34072836a1096f160bf4f7ed81b9a7201f866faf8b2cdbcdaecf161"
  },
  {
   "name": "c79992c4bacd8e73c8c00c529bba40c1c21022a8061d73927843aabf12fce4d6.result.json",
   "bytes": 10642,
   "sha256": "4d764b4c3c13a656f4f1dee1121bdff9e89d7a74200477ccd7b778bf95fbd3ae"
  },
  {
   "name": "def29cd70a74f720920a43676b786bcbfe81bac8b9f5f7adf1a6129fbc31ab77.exit.json",
   "bytes": 390,
   "sha256": "490040384a559fe23dff88d5ff5ac084e1aed968125ababc7ee3389d686396c4"
  },
  {
   "name": "def29cd70a74f720920a43676b786bcbfe81bac8b9f5f7adf1a6129fbc31ab77.result.json",
   "bytes": 10646,
   "sha256": "c931aa265c3f3c41eb0ea3d217d2b40501359f83dd16fd90b87f293efe557a58"
  },
  {
   "name": "ef7e3ff7bfa20f21ddd54e06ad1a24c3273610bed9e64f2a167c276319bdcace.exit.json",
   "bytes": 390,
   "sha256": "cd5b0719faf18c98ecfde089aa67a1c91a8fc7253ac5164e4e8d82610b0c51ae"
  },
  {
   "name": "ef7e3ff7bfa20f21ddd54e06ad1a24c3273610bed9e64f2a167c276319bdcace.result.json",
   "bytes": 10796,
   "sha256": "30e3403a0b886850a740e24d85284c0a6e4a24b89cec0e47600011754f0e5785"
  },
  {
   "name": "existing-image-identity.json",
   "bytes": 294,
   "sha256": "efa68a49d2dd97b9e79873184bcebeda4be6abe8f2b8756bb54e5973cb0f4bf8"
  },
  {
   "name": "failure.json",
   "bytes": 108,
   "sha256": "9c2c7996f791954c2084c92108de3a9940f503fba6c7807633c5611b6bf96625"
  },
  {
   "name": "serving-identity.json",
   "bytes": 142,
   "sha256": "3d114e05dd593e7610b14caed9477e14c4021da37b7fb2dbe50a37b358e49b8e"
  },
  {
   "name": "source-admission.json",
   "bytes": 10492,
   "sha256": "17180c3556331449092547eaa295c49566daed57b2e72020e07a73dfc78c2c04"
  }
 ],
 "contexts": [
  {
   "offset": 0,
   "context_id": "c79992c4bacd8e73c8c00c529bba40c1c21022a8061d73927843aabf12fce4d6",
   "request_sha256": "3f7bd106539718824b81f2f64a8ec32f947ad15930c8f5b95a5d65693d4e12ad"
  },
  {
   "offset": 1,
   "context_id": "934a91780ee861efe986fd0f987826ac51fbb6600ee45242c871bf1e9a1c172e",
   "request_sha256": "eebb23e380f8c3550ec40a9cfc9b31dc22c9e53faedae3c1b1ea872d232680ff"
  },
  {
   "offset": 2,
   "context_id": "def29cd70a74f720920a43676b786bcbfe81bac8b9f5f7adf1a6129fbc31ab77",
   "request_sha256": "aa7b04f5d8778ea3e0a356c5139a6343a2a9be930a344d15d4395a039f5a4cd5"
  },
  {
   "offset": 3,
   "context_id": "ef7e3ff7bfa20f21ddd54e06ad1a24c3273610bed9e64f2a167c276319bdcace",
   "request_sha256": "b1df95e1f4a36ee30b24672cb7d620f058435651042fede5930988791b93ab0a"
  },
  {
   "offset": 4,
   "context_id": "96f842c2c509cadf8392776e18c0b431fbcd372db381705d7ffec758a3880cf0",
   "request_sha256": "4596b65b88e60acc53ae73c26776028aac90b8d64c04339807679f117220049d"
  },
  {
   "offset": 5,
   "context_id": "268f602ae7fe9bd334e053e34f8f046decf6ab0245610eeb2f373a54a2006525",
   "request_sha256": "23b46099923f04ff8587b6ae437b1d80a3e05ca85bc214b4bd0c52d35dc534f6"
  }
 ]
});

const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('\0')===[...keys].sort().join('\0');
const requireValue=(ok,label)=>{if(!ok)throw new CollectionRefusal('contract_refused',{contract:label});};
export function canonical(v){if(v===null||typeof v==='boolean')return JSON.stringify(v);if(typeof v==='string'&&/^[\x20-\x7e]*$/.test(v))return JSON.stringify(v);if(typeof v==='number'&&Number.isSafeInteger(v)&&!Object.is(v,-0))return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>canonical(k)+':'+canonical(v[k])).join(',')+'}';throw Error('Noncanonical public model metadata');}
export const digest=v=>createHash('sha256').update(canonical(v),'ascii').digest('hex');
export function invocation(env,event){
 assertClubArenaRepository(env.GITHUB_REPOSITORY,env.GITHUB_REPOSITORY_ID);
 requireValue(env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_REF==='refs/heads/main','Explicit protected-main dispatch required');
 const p=event.inputs;
 requireValue(exact(p,['dataset','candidate_sha','image_id','stage_run'])&&UUID.test(p.dataset)&&SHA.test(p.candidate_sha)&&(IMAGE.test(p.image_id)||p.image_id===RESOLVE_EXISTING_IMAGE)&&/^[1-9][0-9]*$/.test(p.stage_run),'Exact staged-image selection required');
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
/** Resolve only the canonical tag written by engine-release-transaction.sh. */
export function remoteImageResolutionCommand(sha,tree){
 requireValue(SHA.test(sha)&&SHA.test(tree),'Exact existing image source required');
 const script=`set -euo pipefail
exec 9>/var/lock/club-arena-engine-up.lock
flock -n 9 || { echo 'Existing release lock is busy' >&2; exit 75; }
clock=$(TZ=America/Chicago date +%H%M)
if [ "$clock" -ge 350 ] && [ "$clock" -le 406 ]; then echo 'Daily engine maintenance owns this interval' >&2; exit 75; fi
before=$(docker container inspect -f '{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.State.Status}}|{{index .Config.Labels "sp.release.sha"}}' club-arena-engine)
case "$before" in *'|running|'*) ;; *) echo 'Serving engine is not running' >&2; exit 1;; esac
image=$(docker image inspect -f '{{.Id}}' 'club-arena-engine:${sha}')
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Existing immutable image unavailable' >&2; exit 1; }
# After this single tag lookup every inspection and execution is pinned to the immutable ID.
[ "$(docker image inspect -f '{{.Id}}' "$image")" = "$image" ]
[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = '${sha}' ]
[ "$(docker image inspect -f '{{index .Config.Labels "com.smarterpoker.engine.source-tree"}}' "$image")" = '${tree}' ]
[ "$(docker image inspect -f '{{index .Config.Labels "com.smarterpoker.engine.build-contract"}}' "$image")" = 'clean-server-archive-v1' ]
after=$(docker container inspect -f '{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.State.Status}}|{{index .Config.Labels "sp.release.sha"}}' club-arena-engine)
[ "$before" = "$after" ] || { echo 'Serving engine identity changed' >&2; exit 1; }
printf '{"format":"public215_existing_image_identity_v1","candidate_sha":"${sha}","image_id":"%s","server_tree":"${tree}","build_contract":"clean-server-archive-v1"}\\n' "$image"`;
 return 'bash -c '+"'"+script.replaceAll("'","'\\''")+"'";
}
export function existingImageIdentity(value,sha,tree){
 requireValue(exact(value,['format','candidate_sha','image_id','server_tree','build_contract'])&&value.format==='public215_existing_image_identity_v1'&&SHA.test(sha)&&SHA.test(tree)&&value.candidate_sha===sha&&value.server_tree===tree&&value.build_contract==='clean-server-archive-v1'&&IMAGE.test(value.image_id),'Exact existing immutable image identity required');
 return value.image_id;
}
export function resolveImageSelection(selected,tree,lookup,write){
 if(IMAGE.test(selected.image_id))return selected.image_id;
 requireValue(selected.image_id===RESOLVE_EXISTING_IMAGE,'Exact staged-image selection required');
 const identity=JSON.parse(lookup(remoteImageResolutionCommand(selected.candidate_sha,tree)));
 const image=existingImageIdentity(identity,selected.candidate_sha,tree);
 write('existing-image-identity.json',canonical(identity)+'\n');
 return image;
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
printf 'PUBLIC215_NATIVE_EXIT=%s\\n' "$result_code" >&2
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

// Only fixed classifications reach durable evidence. Never serialize an Error,
// command line, stderr, response body, redirect URL, environment or credential.
const CAUSES=new Set(['ENOENT','EACCES','ETIMEDOUT','ENOBUFS','ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
class CollectionRefusal extends Error{constructor(code,facts={}){super(facts.contract??code);this.code=code;this.facts=facts;}}
const refuse=(code,facts={})=>{throw new CollectionRefusal(code,facts);};
const causeCode=e=>['AbortError','TimeoutError'].includes(e?.name)?'timeout':CAUSES.has(e?.cause?.code)?e.cause.code:CAUSES.has(e?.code)?e.code:'unavailable';
export function commandFacts(result,ssh=true){
 const stderr=typeof result.stderr==='string'?result.stderr:Buffer.isBuffer(result.stderr)?result.stderr.toString('utf8'):'';
 const native=[...stderr.matchAll(/^PUBLIC215_NATIVE_EXIT=([0-9]{1,3})\r?$/gm)];
 const nativeExit=native.length===1&&Number(native[0][1])<=255?Number(native[0][1]):null;
 const fixed=[['Existing release lock is busy','host_lock_busy'],['Daily engine maintenance owns this interval','daily_boundary'],['Serving engine is not running','serving_not_running'],['Owned finite context already exists; inspect its outcome','owned_context_exists'],['Serving engine identity changed','serving_identity_changed']];
 const host=fixed.filter(([message])=>stderr.split(/\r?\n/).includes(message));
 // The existing immutable CLI only exposes these fixed terminal categories.
 const tags=new Set(['FAILED','REQUEST','REPRESENTATION','IMPLEMENTED_FEATURE_SCHEMA','CONTEXT','PROVENANCE','CASES','CARDS','CANONICAL_OWN','STREET','DUPLICATE_CARD','DUPLICATE_CASE','WORKER_REQUIRED','LINUX_NODE22_REQUIRED','EXECUTION_BUDGET','REQUEST_SHA_REQUIRED','REQUEST_TOO_LARGE','REQUEST_SHA','WORKER_TERMINAL']);
 const matches=[...stderr.matchAll(/^PUBLIC215_PREFLIGHT_([A-Z0-9_]+)\r?$/gm)].filter(m=>tags.has(m[1]));
 const tag=matches.length===1?'PUBLIC215_PREFLIGHT_'+matches[0][1]:null;
 const http=stderr.match(/\bHTTP ([1-5][0-9]{2})\b/);
 return {command_exit:Number.isInteger(result.status)?result.status:null,ssh_exit:ssh&&Number.isInteger(result.status)?result.status:null,http_status:http?Number(http[1]):null,native_exit:nativeExit,signal:['SIGTERM','SIGKILL','SIGABRT','SIGSEGV'].includes(result.signal)?result.signal:null,errno:result.error?causeCode(result.error):null,host_code:host.length===1?host[0][1]:null,native_code:tag};
}
export function failureEvidence(error,state){
 return {format:'public215_linux_preflight_failure_v2',status:'incomplete_unqualified_no_freeze_or_activation',...state,phase:error?.collectionPhase==='health_after'?'health_after':state.phase,code:error instanceof CollectionRefusal?error.code:'contract_refused',facts:error instanceof CollectionRefusal?error.facts:{},secondary_evidence_unavailable:error?.secondaryEvidenceUnavailable===true};
}
function command(binary,args,options={}){
 const {native=false,terminal,...spawnOptions}=options;
 const r=spawnSync(binary,args,{encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024,...spawnOptions});
 const facts=commandFacts(r,binary===process.env.PUBLIC215_SSH_COMMAND);
 if(terminal)terminal(facts);
 if(r.error||r.status!==0||(native&&facts.native_exit!==0))refuse('command_failed',facts);
 return options.encoding===null?r.stdout:r.stdout.trim();
}
async function rpc(name,args){
 requireValue(process.env.SUPABASE_URL===DB&&process.env.SUPABASE_SERVICE_ROLE_KEY,'Canonical configured SQL identity required');
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;let response;
 try{response=await fetch(DB+'/rest/v1/rpc/'+name,{method:'POST',signal:AbortSignal.timeout(30000),headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(args)});}catch(error){refuse('preparation_transport',{errno:causeCode(error)});}
 if(!response.ok)refuse('preparation_http',{http_status:response.status});
 const text=await response.text();requireValue(Buffer.byteLength(text)<=8*1024*1024,'Bounded preparation metadata required');return JSON.parse(text);
}
async function healthy(){
 let r;try{r=await fetch('https://engine.smarter.poker/health?public215-preflight='+Date.now(),{signal:AbortSignal.timeout(15000)});}catch(error){refuse('health_transport',{errno:causeCode(error)});}
 if(!r.ok)refuse('health_http',{http_status:r.status});return servingIdentity(await r.json());
}

// Closed corrected-run continuation: only the reviewed 79 original exit0 receipts.
const correctedHandoffBytes=readFileSync(new URL('./fixtures/public215-corrected-r7-linux-handoff.json',import.meta.url));
requireValue(createHash('sha256').update(correctedHandoffBytes).digest('hex')==='7bf8cefeb60e4dbf8478ead73dfc293baf36be8e158c5a37c4cc008aa372ca39','Corrected continuation fixture bytes differ');
export const CORRECTED_R7_RESUME_HANDOFF=Object.freeze(JSON.parse(correctedHandoffBytes));
export function resumeSelection(selected,tree,servingSha,image){
 const m=selected.dataset===R7_RESUME_HANDOFF.dataset?R7_RESUME_HANDOFF:selected.dataset===CORRECTED_R7_RESUME_HANDOFF.dataset?CORRECTED_R7_RESUME_HANDOFF:null;
 if(!m)return null;
 requireValue(selected.candidate_sha===m.candidate_sha&&selected.stage_run===m.stage_run&&image===m.image_id&&tree===m.server_tree&&servingSha===m.serving_sha,'Explicit R7 continuation identity differs');return m;
}
export function resumeProvider(m,run,jobs,artifact){
 const p=m.predecessor;
 requireValue(run?.id===p.run_id&&run.run_attempt===p.attempt&&run.head_sha===p.head_sha&&run.repository?.id===1132369872&&run.head_repository?.id===1132369872&&run.path==='.github/workflows/public215-linux-preflight.yml'&&run.event==='workflow_dispatch'&&run.head_branch==='main'&&run.status==='completed'&&run.conclusion==='failure','Exact terminal predecessor run required');
 requireValue(Array.isArray(jobs)&&jobs.length===2&&jobs.every(j=>j.run_id===p.run_id&&j.head_sha===p.head_sha&&j.status==='completed'),'Complete exact predecessor jobs required');
 const contract=jobs.filter(j=>j.id===p.contract_job&&j.name==='contract'&&j.conclusion==='success');
 const evidence=jobs.filter(j=>j.id===p.evidence_job&&j.name==='evidence'&&j.conclusion==='failure');
 requireValue(contract.length===1&&evidence.length===1,'Exact predecessor contract and partial collector required');
 for(const [name,conclusion]of [['Existing protected PR and exact candidate source admission','success'],['Establish existing pinned SSH identity','success'],['Read approved preparations and collect bounded isolated Linux receipts','failure'],['Retain execution receipts only','success']]){
  const steps=evidence[0].steps?.filter(s=>s.name===name);requireValue(steps?.length===1&&steps[0].status==='completed'&&steps[0].conclusion===conclusion,'Exact predecessor executed steps required');
 }
 const a=artifact,w=a?.workflow_run;
 requireValue(a?.id===p.artifact_id&&a.name===p.artifact_name&&a.expired===false&&a.size_in_bytes===p.archive_bytes&&a.digest==='sha256:'+p.archive_sha256&&w?.id===p.run_id&&w.repository_id===1132369872&&w.head_repository_id===1132369872&&w.head_branch==='main'&&w.head_sha===p.head_sha,'Exact unexpired first-party predecessor artifact required');
}

// Official artifact API: one authenticated 302, then one credential-free 200.
// https://docs.github.com/en/rest/actions/artifacts#download-an-artifact
export async function downloadResumeArchive(m,{fetchImpl=fetch,token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN}={}){
 requireValue(typeof token==='string'&&token.length>0,'Configured workflow artifact reader required');
 const deadline=Date.now()+20000;
 const request=async(stage,url,headers={})=>{
  const remaining=deadline-Date.now();if(remaining<=0)refuse('resume_transport',{stage,errno:'timeout'});
  try{return await fetchImpl(url,{headers,redirect:'manual',signal:AbortSignal.timeout(remaining)});}catch(error){refuse('resume_transport',{stage,errno:causeCode(error)});}
 };
 const api=await request('api',`https://api.github.com/repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/actions/artifacts/${m.predecessor.artifact_id}/zip`,{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'});
 if(api.status!==302){void api.body?.cancel().catch(()=>{});refuse('resume_http',{stage:'api',http_status:api.status});}
 let target;try{target=new URL(api.headers.get('location'));}catch{refuse('resume_redirect');}finally{void api.body?.cancel().catch(()=>{});}
 requireValue(target.protocol==='https:'&&!target.username&&!target.password&&!target.port&&!target.hash&&(/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(target.hostname)||target.hostname==='results-receiver.actions.githubusercontent.com'),'Documented credential-free artifact storage required');
 const r=await request('download',target.href);
 if(r.status!==200){void r.body?.cancel().catch(()=>{});refuse('resume_http',{stage:'download',http_status:r.status});}
 const expected=m.predecessor.archive_bytes,length=r.headers.get('content-length');
 if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)!==expected)){void r.body?.cancel().catch(()=>{});refuse('resume_archive_size');}
 requireValue(r.body,'Bounded artifact body required');const reader=r.body.getReader(),parts=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>expected){void reader.cancel().catch(()=>{});refuse('resume_archive_size');}parts.push(Buffer.from(part.value));}}
 catch(error){if(error instanceof CollectionRefusal)throw error;refuse('resume_transport',{stage:'download',errno:causeCode(error)});}finally{reader.releaseLock();}
 const bytes=Buffer.concat(parts,size);requireValue(Date.now()<=deadline&&size===expected&&createHash('sha256').update(bytes).digest('hex')===m.predecessor.archive_sha256,'Exact bounded predecessor archive required');return bytes;
}

// Python's maintained ZIP parser handles provider ZIP64 archives. All members
// are validated in memory before any file is written. No extractall/path writes.
const ZIP_READER=String.raw`import sys,json,base64,io,zipfile,hashlib,stat
try:
 p=json.load(sys.stdin); expected={f['name']:f for f in p['files']}
 assert len(expected)==len(p['files']) and len(expected) in (16,479)
 raw=base64.b64decode(p['archive'],validate=True)
 z=zipfile.ZipFile(io.BytesIO(raw)); entries=z.infolist()
 assert len(entries)==len(expected) and len({i.filename for i in entries})==len(entries)
 result={}
 for i in entries:
  n=i.filename
  assert n in expected and '/' not in n and chr(92) not in n and chr(0) not in n and n not in ('.','..') and not i.is_dir()
  assert not (i.flag_bits & 1) and stat.S_IFMT(i.external_attr >> 16) in (0,stat.S_IFREG)
  f=expected[n]; assert i.file_size==f['bytes'] and i.file_size<=1024*1024
  with z.open(i) as stream: b=stream.read(f['bytes']+1)
  assert len(b)==f['bytes'] and hashlib.sha256(b).hexdigest()==f['sha256']
  result[n]=base64.b64encode(b).decode('ascii')
 print(json.dumps(result,separators=(',',':')))
except Exception:
 sys.exit(1)
`;
export function resumeArchiveFiles(bytes,m=R7_RESUME_HANDOFF){
 requireValue(bytes.length===m.predecessor.archive_bytes&&createHash('sha256').update(bytes).digest('hex')===m.predecessor.archive_sha256,'Exact predecessor archive bytes required');
 const values=JSON.parse(command('python3',['-I','-S','-c',ZIP_READER],{input:JSON.stringify({archive:bytes.toString('base64'),files:m.files})}));
 const files=new Map();for(const f of m.files){const b=Buffer.from(values[f.name],'base64');requireValue(b.length===f.bytes&&createHash('sha256').update(b).digest('hex')===f.sha256,'Pinned predecessor member differs');files.set(f.name,b);}return files;
}
export function resumeFilesAdmission(m,files){
 requireValue(files instanceof Map&&files.size===m.files.length,'Exact predecessor file inventory required');
 for(const f of m.files){const b=files.get(f.name);requireValue(Buffer.isBuffer(b)&&b.length===f.bytes&&createHash('sha256').update(b).digest('hex')===f.sha256,'Pinned predecessor bytes differ');}
 const json=name=>JSON.parse(files.get(name).toString('utf8'));
 requireValue(existingImageIdentity(json('existing-image-identity.json'),m.candidate_sha,m.server_tree)===m.image_id,'Predecessor immutable image differs');
 const serving=json('serving-identity.json');requireValue(exact(serving,['contexts','serving_sha_before','serving_sha_after'])&&serving.contexts===m.contexts.length&&serving.serving_sha_before===m.serving_sha&&serving.serving_sha_after===m.serving_sha,'Predecessor global serving identity differs');
 const source=json('source-admission.json');requireValue(source.format==='public215_protected_source_admission_v1'&&source.candidate_sha===m.candidate_sha&&source.integration?.stage_run===Number(m.stage_run)&&source.status==='source_evidence_only_not_deployed_frozen_or_certified','Predecessor source identity differs');
 requireValue(json('failure.json').status==='incomplete_unqualified_no_freeze_or_activation','Predecessor partial outcome required');
 if(m.dataset===CORRECTED_R7_RESUME_HANDOFF.dataset)correctedResumeBoundary(m,files);
}
export function correctedResumeBoundary(m,files){
 const json=name=>JSON.parse(files.get(name).toString('utf8'));
 requireValue(m.contexts.length===79&&m.files.length===479&&m.contexts.every((c,i)=>c.offset===i)&&new Set(m.contexts.map(c=>c.context_id)).size===79,'Exact corrected prefix required');
 const failure={format:'public215_linux_preflight_failure_v2',status:'incomplete_unqualified_no_freeze_or_activation',phase:'preparation',offset:79,context_id:null,request_sha256:null,code:'preparation_http',facts:{http_status:500},secondary_evidence_unavailable:false};
 requireValue(digest(json('failure.json'))===digest(failure),'Original offset79 preparation HTTP500 required');
 const started=json('attempt-79.started.json');
 requireValue(exact(started,['phase','offset','context_id','request_sha256','observedAt'])&&started.phase==='preparation'&&started.offset===79&&started.context_id===null&&started.request_sha256===null&&typeof started.observedAt==='string','Original unbound offset79 required');
 requireValue(!['bound','native-terminal','terminal'].some(kind=>files.has(`attempt-79.${kind}.json`)),'No offset79 request or native execution may be inherited');
 for(const c of m.contexts){
  const bound=json(`attempt-${c.offset}.bound.json`),terminal=json(`attempt-${c.offset}.terminal.json`),native=json(`attempt-${c.offset}.native-terminal.json`);
  requireValue(bound.phase==='request'&&terminal.phase==='result'&&terminal.status==='actual_ssh_and_native_exit0'&&native.phase==='native'&&[bound,terminal,native].every(v=>v.offset===c.offset&&v.context_id===c.context_id&&v.request_sha256===c.request_sha256),'Original corrected context phases required');
  requireValue(native.command_exit===0&&native.ssh_exit===0&&native.native_exit===0&&['errno','host_code','http_status','native_code','signal'].every(k=>native[k]===null),'Original actual native exit0 required');
  const exit=json(c.context_id+'.exit.json');
  requireValue(exact(exit,['exit_code','context_id','request_sha256','candidate_sha','image_id','stage_run','observedAt'])&&exit.exit_code===0&&exit.context_id===c.context_id&&exit.request_sha256===c.request_sha256&&exit.candidate_sha===m.candidate_sha&&exit.image_id===m.image_id&&exit.stage_run===m.stage_run,'Original corrected exit identity required');
 }

}
export function inheritedEvidence(m,files,offset,cid,requestSha,row){
 const entry=m.contexts.find(c=>c.offset===offset);if(!entry){requireValue(!m.contexts.some(c=>c.context_id===cid),'Predecessor context moved ordinal');return null;}
 requireValue(entry.context_id===cid&&entry.request_sha256===requestSha,'Current preparation differs from explicit predecessor');
 const exit=JSON.parse(files.get(cid+'.exit.json').toString('utf8')),result=JSON.parse(files.get(cid+'.result.json').toString('utf8'));
 requireValue(exact(exit,['exit_code','context_id','request_sha256','candidate_sha','image_id','stage_run','observedAt'])&&exit.exit_code===0&&exit.context_id===cid&&exit.request_sha256===requestSha&&exit.candidate_sha===m.candidate_sha&&exit.image_id===m.image_id&&exit.stage_run===m.stage_run,'Genuine original exit0 binding required');
 resultBinding(result,row,m.dataset);
 // Existing assembler-compatible shapes are checked without reserializing bytes.
 executionEvidence(result,exit,()=>{});return [cid+'.result.json',cid+'.exit.json'];
}
function resultBinding(result,row,dataset){requireValue(result?.format==='public_hist215_preflight_result_v1'&&digest(result.receipt)===result.receipt_checksum&&result.receipt.model_checksum===row.model_checksum&&result.receipt.dataset_id===dataset,'Actual finite Linux result binding differs');}
export async function preservePrimary(body,post,onSecondary){
 let primary;try{await body();}catch(error){primary=error;}
 try{await post();}catch(error){if(!primary){primary=error;primary.collectionPhase='health_after';}else{try{onSecondary(error);}catch{primary.secondaryEvidenceUnavailable=true;}}}
 if(primary)throw primary;
}

async function loadResume(m,out){
 const p=m.predecessor,started=Date.now();let calls=0;
 const read=path=>{requireValue(++calls<=5&&Date.now()-started<120000,'Finite predecessor metadata budget exceeded');return JSON.parse(command('gh',['api',`repos/${process.env.GITHUB_REPOSITORY}${path}`],{timeout:Math.min(20000,120000-(Date.now()-started))}));};
 command('git',['merge-base','--is-ancestor',p.head_sha,'origin/main']);
 const run=read(`/actions/runs/${p.run_id}`),jobs=read(`/actions/runs/${p.run_id}/attempts/${p.attempt}/jobs?per_page=100`),artifact=read(`/actions/artifacts/${p.artifact_id}`);
 requireValue(jobs.total_count===2&&Array.isArray(jobs.jobs)&&jobs.jobs.length===2,'Complete predecessor job census required');resumeProvider(m,run,jobs.jobs,artifact);
 const archive=await downloadResumeArchive(m),files=resumeArchiveFiles(archive,m);resumeFilesAdmission(m,files);
 const prior=join(out,`predecessor-${p.run_id}-${p.attempt}`);mkdirSync(prior,{mode:0o700});
 writeEvidence(prior,'artifact.zip',archive);for(const [name,bytes]of files)writeEvidence(prior,name,bytes);
 return files;
}

async function main(){
 const selected=invocation(process.env,JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')));
 const out=resolve(process.env.PUBLIC215_RECEIPT_DIR||'artifacts/public215-linux-preflight');mkdirSync(out,{recursive:true,mode:0o700});
 const state={phase:'source',offset:null,context_id:null,request_sha256:null};let count=0,imported=0,imageId,before,after;
 const record=(name,value)=>writeEvidence(out,name,canonical(value)+'\n');
 try{
 command('git',['merge-base','--is-ancestor',selected.candidate_sha,'origin/main']);
 const tree=command('git',['rev-parse',selected.candidate_sha+':server']);
 const run=JSON.parse(command('gh',['api',`repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${selected.stage_run}`]));
 const pages=JSON.parse(command('gh',['api','--paginate','--slurp',`repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${selected.stage_run}/jobs?per_page=100`]));stageAdmission(run,pages.flatMap(p=>p.jobs),selected.candidate_sha);
 state.phase='health_before';before=await healthy();const observed=new Set();let resume,prior;
 await preservePrimary(async()=>{
 state.phase='image';imageId=resolveImageSelection(selected,tree,remote=>command(process.env.PUBLIC215_SSH_COMMAND,[remote]),(name,bytes)=>writeEvidence(out,name,bytes));
 resume=resumeSelection(selected,tree,before.releaseSha,imageId);
 if(resume){state.phase='resume';prior=await loadResume(resume,out);record('resume-lineage.json',{format:'public215_linux_explicit_resume_v1',predecessor_run:resume.predecessor.run_id,predecessor_attempt:resume.predecessor.attempt,artifact_id:resume.predecessor.artifact_id,archive_sha256:resume.predecessor.archive_sha256,handoff_sha256:digest(resume),contexts:resume.contexts,status:resume===R7_RESUME_HANDOFF?'six_prior_receipts_only_remaining_contexts_required':`${resume.contexts.length}_prior_receipts_only_remaining_contexts_required`});}
 for(let offset=0;offset<=1024;offset++){
  Object.assign(state,{phase:'preparation',offset,context_id:null,request_sha256:null});record(`attempt-${offset}.started.json`,{...state,observedAt:new Date().toISOString()});
  const page=await rpc('fn_gto_v31_model_preparations',{p_dataset_id:selected.dataset,p_offset:offset,p_limit:1});requireValue(Array.isArray(page)&&page.length<=1,'One private preparation page required');if(!page.length){record(`attempt-${offset}.terminal.json`,{...state,status:'end_of_preparations'});break;}
  state.phase='request';const row=page[0],request=programRequest(row,selected.dataset),cid=digest(row.context);state.context_id=cid;requireValue(!observed.has(cid),'Duplicate private preparation');observed.add(cid);
  sourceGraph(row.encoder_descriptor,row.public_training_provenance.encoder_checksum,path=>Buffer.from(command('git',['show',selected.candidate_sha+':'+path],{encoding:null})));
  const bytes=canonical(request),requestSha=createHash('sha256').update(bytes,'ascii').digest('hex');state.request_sha256=requestSha;
  record(`attempt-${offset}.bound.json`,{...state,observedAt:new Date().toISOString()});
  state.phase='inherit';const inherited=resume?inheritedEvidence(resume,prior,offset,cid,requestSha,row):null;
  if(inherited){for(const name of inherited)writeEvidence(out,name,prior.get(name));imported++;record(`attempt-${offset}.terminal.json`,{...state,status:'inherited_exact_original_exit0',predecessor_run:resume.predecessor.run_id});count++;continue;}
  state.phase='native';
  const result=JSON.parse(command(process.env.PUBLIC215_SSH_COMMAND,[remoteCommand(selected.candidate_sha,imageId,tree,requestSha,process.env.GITHUB_RUN_ID+'-'+process.env.GITHUB_RUN_ATTEMPT)],{input:bytes,timeout:330000,native:true,terminal:facts=>record(`attempt-${offset}.native-terminal.json`,{...state,...facts})}));
  state.phase='result';resultBinding(result,row,selected.dataset);
  executionEvidence(result,{exit_code:0,context_id:cid,request_sha256:requestSha,candidate_sha:selected.candidate_sha,image_id:imageId,stage_run:selected.stage_run,observedAt:new Date().toISOString()},(name,bytes)=>writeEvidence(out,name,bytes));count++;
  record(`attempt-${offset}.terminal.json`,{...state,status:'actual_ssh_and_native_exit0'});
 }
 state.phase='census';requireValue(count===107&&(!resume||imported===resume.contexts.length),'Complete 107-context private preparation set required');
 },async()=>{
  after=await healthy();record('serving-identity.json',{serving_sha_before:before.releaseSha,serving_sha_after:after.releaseSha,contexts:count});requireValue(before.releaseSha===after.releaseSha,'Healthy serving identity changed');if(resume)requireValue(after.releaseSha===resume.serving_sha,'Original continuation serving identity changed');
 },error=>record('post-health-failure.json',failureEvidence(error,{phase:'health_after',offset:state.offset,context_id:state.context_id,request_sha256:state.request_sha256})));
 if(resume)record('resume-completion.json',{format:'public215_linux_explicit_resume_complete_v1',imported_contexts:imported,new_contexts:count-imported,total_contexts:count,predecessor_run:resume.predecessor.run_id});
 state.phase='complete';record('receipt.json',{format:'public215_linux_preflight_control_v1',dataset_id:selected.dataset,candidate_sha:selected.candidate_sha,image_id:imageId,stage_run:selected.stage_run,contexts:count,serving_sha_before:before.releaseSha,serving_sha_after:after.releaseSha,status:'execution_evidence_only_not_frozen_or_certified'});
 }catch(error){record('failure.json',failureEvidence(error,state));throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Finite public215 Linux preflight refused; retained typed evidence is incomplete and unqualified');process.exitCode=1;});
