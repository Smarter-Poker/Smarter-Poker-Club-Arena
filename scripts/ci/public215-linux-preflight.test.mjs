import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {invocation,stageAdmission,sourceGraph,remoteCommand,GRAPH_FILES,digest,programRequest,executionEvidence,RESOLVE_EXISTING_IMAGE,remoteImageResolutionCommand,existingImageIdentity,resolveImageSelection} from './public215-linux-preflight.mjs';
const sha='a'.repeat(40),image='sha256:'+'b'.repeat(64),hex='c'.repeat(64);
const env={GITHUB_REPOSITORY:'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',GITHUB_REPOSITORY_ID:'1132369872',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main'};
const inputs={dataset:'11111111-1111-4111-8111-111111111111',candidate_sha:sha,image_id:image,stage_run:'123'};
test('only the explicit protected-main immutable dataset/image dispatch is admitted',()=>{
 assert.equal(invocation(env,{inputs}),inputs);
 for(const e of [{...env,GITHUB_EVENT_NAME:'schedule'},{...env,GITHUB_REF:'refs/heads/feature'},{...env,GITHUB_REPOSITORY_ID:'1'}])assert.throws(()=>invocation(e,{inputs}));
 assert.throws(()=>invocation(env,{inputs:{...inputs,image_id:'tag:mutable'}}));
});
test('existing exact staged release admission requires every executed shard and production door',()=>{
 const run={path:'.github/workflows/auto-deploy-hetzner.yml',event:'repository_dispatch',head_branch:'main',display_title:'Engine Release '+sha};
 const jobs=[...Array.from({length:4},(_,i)=>`Test The Exact Engine Release Request (shard ${i+1}/4)`),'Prove The Exact Engine Has Every Production Door'].map(name=>({name,status:'completed',conclusion:'success'}));
 stageAdmission(run,jobs,sha);assert.throws(()=>stageAdmission({...run,display_title:'Engine Release '+'d'.repeat(40)},jobs,sha));
 assert.throws(()=>stageAdmission(run,jobs.map((j,i)=>i?j:{...j,conclusion:'skipped'}),sha));assert.throws(()=>stageAdmission(run,jobs.slice(1),sha));
});
test('closed ten-file approved graph maps absolute Mac paths to exact committed CA bytes',()=>{
 const descriptor={format:'public_hist215_encoder_source_graph_v1',files:GRAPH_FILES.map(p=>({path:'/Volumes/Fake/owned/'+p,sha256:createHash('sha256').update(p).digest('hex')}))};
 sourceGraph(descriptor,digest(descriptor),p=>Buffer.from(p));
 assert.throws(()=>sourceGraph(descriptor,hex,p=>Buffer.from(p)));
 assert.throws(()=>sourceGraph(descriptor,digest(descriptor),()=>Buffer.from('changed')));
 const bad=structuredClone(descriptor);bad.files[0].path='/Users/test/.env';assert.throws(()=>sourceGraph(bad,digest(bad),p=>Buffer.from(p)));
});
test('host invocation is isolated, resource bounded and never builds, activates or receives credentials',()=>{
 const command=remoteCommand(sha,image,'d'.repeat(40),hex,'123-1');
 for(const flag of ['--pull=never','--network none','--read-only','--cap-drop ALL','--security-opt no-new-privileges','--cpus .5','--memory 512m','--pids-limit 64','--user node','flock -n 9','public215ModelPreflight.js'])assert.ok(command.includes(flag));
 assert.doesNotMatch(command,/--env-file|--volume|--privileged|docker build|docker pull|systemctl|engine-up\.sh|\.env/);
 assert.ok(command.includes('result_code=$?'));assert.ok(command.includes('docker rm -f'));assert.throws(()=>remoteCommand(sha,image,'d'.repeat(40),hex,'unsafe;command'));
});
test('approved cases and full program hashes are bound without caller feature overrides',()=>{
 const context={street:'river'},template={context},provenance={encoder_checksum:digest({format:'graph'})};
 const protocol={contexts:[{context,cases:[{board:'AsKdQcJhTs',own:['2c','2d']},{board:'AsKdQcJhTs',own:['3c','3d']}]}]};provenance.runtime_parity_protocol_checksum=digest(protocol);
 const model={template_sha256:digest(template),provenance_sha256:digest(provenance),feature_schema_sha256:hex};
 const row={dataset_id:inputs.dataset,status:'prepared',context,policy_representation:'public_hist215_v1',public_model:model,public_template:template,public_training_provenance:provenance,model_checksum:digest(model),template_checksum:digest(template),feature_schema_checksum:hex,training_provenance_checksum:digest(provenance),runtime_parity_protocol:protocol,encoder_descriptor:{format:'graph'}};
 assert.equal(programRequest(row,inputs.dataset).cases,protocol.contexts[0].cases);
 assert.throws(()=>programRequest({...row,model_checksum:hex},inputs.dataset));assert.throws(()=>programRequest({...row,status:'frozen'},inputs.dataset));
 const workflow=readFileSync(new URL('../../.github/workflows/public215-linux-preflight.yml',import.meta.url),'utf8');
 assert.match(workflow,/node scripts\/ci\/public215-source-admission\.mjs/);assert.doesNotMatch(workflow,/schedule:|workflow_run:|auto-deploy-hetzner\.yml.*dispatch/);
});

test('Linux stdout and actual terminal metadata remain separate assembler-compatible artifacts',()=>{
 const result={format:'public_hist215_preflight_result_v1',receipt:{model_checksum:hex},receipt_checksum:hex,execution_ms_f64:'3ff0000000000000',peak_rss_bytes:1024};
 const metadata={exit_code:0,context_id:hex,request_sha256:hex,candidate_sha:sha,image_id:image,stage_run:'123',observedAt:'2026-10-29T00:00:00.000Z'};
 const files=[];executionEvidence(result,metadata,(name,bytes)=>files.push({name,value:JSON.parse(bytes)}));
 assert.deepEqual(files.map(f=>f.name),[hex+'.result.json',hex+'.exit.json']);assert.deepEqual(files[0].value,result);assert.deepEqual(files[1].value,metadata);
 assert.throws(()=>executionEvidence({...result,request_checksum:hex},metadata,()=>{}));
 assert.throws(()=>executionEvidence(result,{...metadata,exit_code:1},()=>{}));
 const partial=[];assert.throws(()=>executionEvidence(result,metadata,(name)=>{partial.push(name);throw Error('result write failed');}));assert.deepEqual(partial,[hex+'.result.json']);
});

test('existing canonical build tag resolves once to one retained immutable identity; manual IDs are unchanged',()=>{
 const tree='d'.repeat(40),identity={format:'public215_existing_image_identity_v1',candidate_sha:sha,image_id:image,server_tree:tree,build_contract:'clean-server-archive-v1'};
 const selection={...inputs,image_id:RESOLVE_EXISTING_IMAGE};
 assert.equal(invocation(env,{inputs:selection}),selection);
 const calls=[],files=[];
 assert.equal(resolveImageSelection(selection,tree,command=>{calls.push(command);return JSON.stringify(identity);},(name,bytes)=>files.push({name,value:JSON.parse(bytes)})),image);
 assert.equal(calls.length,1);assert.deepEqual(files,[{name:'existing-image-identity.json',value:identity}]);
 assert.equal(resolveImageSelection(inputs,tree,()=>{throw Error('manual ID must not resolve');},()=>{throw Error('manual ID must not write resolution');}),image);
 assert.equal(existingImageIdentity(identity,sha,tree),image);
 for(const bad of [{...identity,candidate_sha:'e'.repeat(40)},{...identity,server_tree:'e'.repeat(40)},{...identity,build_contract:'other'},{...identity,image_id:'club-arena-engine:'+sha},{...identity,extra:true},{}]){
  assert.throws(()=>existingImageIdentity(bad,sha,tree));
  assert.throws(()=>resolveImageSelection(selection,tree,()=>JSON.stringify(bad),()=>{throw Error('must not retain invalid metadata');}));
 }
 assert.throws(()=>resolveImageSelection(selection,tree,()=>'{',()=>{}));
 assert.throws(()=>resolveImageSelection(selection,tree,()=>{throw Error('missing image or locked host');},()=>{}));
 assert.throws(()=>resolveImageSelection({...inputs,image_id:'club-arena-engine:'+sha},tree,()=>{},()=>{}));
 assert.throws(()=>remoteCommand(sha,RESOLVE_EXISTING_IMAGE,tree,hex,'123-1'));
 const source=readFileSync(new URL('./public215-linux-preflight.mjs',import.meta.url),'utf8');
 assert.ok(source.indexOf('imageId=resolveImageSelection')<source.indexOf('for(let offset='));
 assert.match(source,/remoteCommand\(selected.candidate_sha,imageId,tree/);
 assert.doesNotMatch(source,/image_id:selected.image_id|remoteCommand\(selected.candidate_sha,selected.image_id/);
});
test('existing image discovery is read-only, exact-source bound and guarded against serving changes',()=>{
 const command=remoteImageResolutionCommand(sha,'d'.repeat(40));
 assert.equal(command.split('club-arena-engine:'+sha).length-1,1);
 for(const required of ['flock -n 9','America/Chicago','-ge 350','-le 406','before=$(docker container inspect','after=$(docker container inspect','org.opencontainers.image.revision','com.smarterpoker.engine.source-tree','com.smarterpoker.engine.build-contract','clean-server-archive-v1','public215_existing_image_identity_v1'])assert.ok(command.includes(required),required);
 assert.equal((command.match(/docker image inspect/g)||[]).length,5);
 assert.doesNotMatch(command,/docker run|docker build|docker pull|docker images|docker tag|docker rm|--env|--volume|systemctl|\.env/);
 assert.throws(()=>remoteImageResolutionCommand('main','d'.repeat(40)));
 assert.throws(()=>remoteImageResolutionCommand(sha,'tree;false'));
});

// The handoff is an explicit immutable input in this already-watched module.
import {spawnSync} from 'node:child_process';
import {R7_RESUME_HANDOFF,CORRECTED_R7_RESUME_HANDOFF,correctedResumeBoundary,resumeSelection,resumeProvider,downloadResumeArchive,resumeArchiveFiles,resumeFilesAdmission,inheritedEvidence,commandFacts,failureEvidence,preservePrimary} from './public215-linux-preflight.mjs';
const pinned=R7_RESUME_HANDOFF,prior=pinned.predecessor;
function providerFixture(handoff=pinned){
 const prior=handoff.predecessor;
 const run={id:prior.run_id,run_attempt:prior.attempt,head_sha:prior.head_sha,repository:{id:1132369872},head_repository:{id:1132369872},path:'.github/workflows/public215-linux-preflight.yml',event:'workflow_dispatch',head_branch:'main',status:'completed',conclusion:'failure'};
 const base={run_id:prior.run_id,head_sha:prior.head_sha,status:'completed'};
 const jobs=[{...base,id:prior.contract_job,name:'contract',conclusion:'success'},{...base,id:prior.evidence_job,name:'evidence',conclusion:'failure',steps:[['Existing protected PR and exact candidate source admission','success'],['Establish existing pinned SSH identity','success'],['Read approved preparations and collect bounded isolated Linux receipts','failure'],['Retain execution receipts only','success']].map(([name,conclusion])=>({name,status:'completed',conclusion}))}];
 const artifact={id:prior.artifact_id,name:prior.artifact_name,expired:false,size_in_bytes:prior.archive_bytes,digest:'sha256:'+prior.archive_sha256,workflow_run:{id:prior.run_id,repository_id:1132369872,head_repository_id:1132369872,head_branch:'main',head_sha:prior.head_sha}};
 return {run,jobs,artifact};
}
test('six-receipt continuation is pinned to the original dataset/source/stage/image/global identity',()=>{
 const selected={dataset:pinned.dataset,candidate_sha:pinned.candidate_sha,stage_run:pinned.stage_run,image_id:RESOLVE_EXISTING_IMAGE};
 assert.equal(resumeSelection(selected,pinned.server_tree,pinned.serving_sha,pinned.image_id),pinned);
 assert.equal(resumeSelection({...selected,dataset:inputs.dataset},pinned.server_tree,pinned.serving_sha,pinned.image_id),null);
 for(const field of ['candidate_sha','stage_run'])assert.throws(()=>resumeSelection({...selected,[field]:field==='candidate_sha'?sha:'1'},pinned.server_tree,pinned.serving_sha,pinned.image_id));
 for(const values of [[sha,pinned.serving_sha,pinned.image_id],[pinned.server_tree,sha,pinned.image_id],[pinned.server_tree,pinned.serving_sha,image]])assert.throws(()=>resumeSelection(selected,...values));
 assert.equal(pinned.files.length,16);assert.equal(new Set(pinned.files.map(f=>f.name)).size,16);assert.deepEqual(pinned.contexts.map(c=>c.offset),[0,1,2,3,4,5]);
 assert.deepEqual(Object.keys(invocation(env,{inputs})),['dataset','candidate_sha','image_id','stage_run']);
});
test('provider continuation requires the exact first-party completed attempt and successful original source/SSH gates',()=>{
 const f=providerFixture();resumeProvider(pinned,f.run,f.jobs,f.artifact);
 for(const change of [{id:1},{run_attempt:2},{head_sha:sha},{event:'pull_request'},{conclusion:'success'},{status:'in_progress'},{repository:{id:1}}])assert.throws(()=>resumeProvider(pinned,{...f.run,...change},f.jobs,f.artifact));
 for(const change of [{expired:true},{digest:'sha256:'+hex},{id:1},{size_in_bytes:1},{workflow_run:{...f.artifact.workflow_run,head_sha:sha}}])assert.throws(()=>resumeProvider(pinned,f.run,f.jobs,{...f.artifact,...change}));
 for(let i=0;i<4;i++){const bad=structuredClone(f.jobs);bad[1].steps[i].conclusion=i===2?'success':'skipped';assert.throws(()=>resumeProvider(pinned,f.run,bad,f.artifact));}
 assert.throws(()=>resumeProvider(pinned,f.run,f.jobs.slice(1),f.artifact));
 assert.throws(()=>resumeProvider(pinned,f.run,[...f.jobs,{...f.jobs[0],id:1}],f.artifact));
});
function zipFixture(mode='valid',count=16){
 const files=Array.from({length:count},(_,i)=>({name:`file-${i}.json`,value:Buffer.from(`value-${i}`)}));
 const program=String.raw`import sys,json,io,zipfile,base64,stat
p=json.load(sys.stdin); out=io.BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 for i,f in enumerate(p['files']):
  name=f['name']
  if i==0 and p['mode']=='traversal': name='../file-0.json'
  if i==0 and p['mode']=='backslash': name='a'+chr(92)+'file-0.json'
  if i==1 and p['mode']=='duplicate': name=p['files'][0]['name']
  info=zipfile.ZipInfo(name)
  if i==0 and p['mode']=='symlink': info.create_system=3; info.external_attr=(stat.S_IFLNK|0o777)<<16
  z.writestr(info,base64.b64decode(f['value']))
sys.stdout.buffer.write(out.getvalue())`;
 const r=spawnSync('python3',['-c',program],{input:JSON.stringify({mode,files:files.map(f=>({name:f.name,value:f.value.toString('base64')}))}),maxBuffer:1024*1024});assert.equal(r.status,0);
 const bytes=r.stdout,m={predecessor:{archive_bytes:bytes.length,archive_sha256:createHash('sha256').update(bytes).digest('hex')},files:files.map(f=>({name:f.name,bytes:f.value.length,sha256:createHash('sha256').update(f.value).digest('hex')}))};return {bytes,m,files};
}
test('real ZIP reader admits exact bytes and refuses member substitution, duplicates, traversal, symlinks and truncation',()=>{
 const {bytes,m,files}=zipFixture();const parsed=resumeArchiveFiles(bytes,m);assert.equal(parsed.size,16);for(const f of files)assert.deepEqual(parsed.get(f.name),f.value);
 for(const mode of ['traversal','backslash','duplicate','symlink']){const bad=zipFixture(mode);assert.throws(()=>resumeArchiveFiles(bad.bytes,bad.m));}
 assert.throws(()=>resumeArchiveFiles(bytes.subarray(1),m));
 const wrong=structuredClone(m);wrong.files[0].sha256=hex;assert.throws(()=>resumeArchiveFiles(bytes,wrong));
 const corrupt=Buffer.from(bytes);corrupt[40]^=1;const tampered={...m,predecessor:{archive_bytes:corrupt.length,archive_sha256:createHash('sha256').update(corrupt).digest('hex')}};assert.throws(()=>resumeArchiveFiles(corrupt,tampered));
});
test('official artifact download isolates API credentials and verifies the full pinned ZIP before use',async()=>{
 const f=zipFixture(),calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url,options});return calls.length===1?new Response(null,{status:302,headers:{location:'https://artifacts.blob.core.windows.net/object?sig=do-not-print'}}):new Response(f.bytes);};
 assert.deepEqual(await downloadResumeArchive(f.m,{fetchImpl,token:'test-api-only'}),f.bytes);
 assert.equal(calls.length,2);assert.equal(calls[0].options.headers.Authorization,'Bearer test-api-only');assert.deepEqual(calls[1].options.headers,{});assert.equal(calls[1].options.redirect,'manual');
 for(const location of ['http://artifacts.blob.core.windows.net/a','https://evil.example/a','https://user:password@artifacts.blob.core.windows.net/a','https://artifacts.blob.core.windows.net:444/a']){
  let calls=0;await assert.rejects(downloadResumeArchive(f.m,{token:'test',fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}}));assert.equal(calls,1);
 }
 await assert.rejects(downloadResumeArchive(f.m,{token:'test',fetchImpl:async()=>new Response('private signed URL',{status:403})}),e=>JSON.stringify(failureEvidence(e,{phase:'resume'})).includes('403')&&!JSON.stringify(failureEvidence(e,{phase:'resume'})).includes('private'));
 let n=0;await assert.rejects(downloadResumeArchive(f.m,{token:'test',fetchImpl:async()=>++n===1?new Response(null,{status:302,headers:{location:'https://a.blob.core.windows.net/a'}}):new Response(null,{status:302,headers:{location:'https://evil.example'}})}));assert.equal(n,2);
});
function inheritedFixture(){
 const files=new Map(),model='d'.repeat(64);
 for(const c of pinned.contexts){
  const receipt={dataset_id:pinned.dataset,model_checksum:model};const result={format:'public_hist215_preflight_result_v1',receipt,receipt_checksum:digest(receipt),execution_ms_f64:'3ff0000000000000',peak_rss_bytes:1024};
  const exit={exit_code:0,context_id:c.context_id,request_sha256:c.request_sha256,candidate_sha:pinned.candidate_sha,image_id:pinned.image_id,stage_run:pinned.stage_run,observedAt:'2026-10-30T09:09:10.151Z'};
  // Deliberately preserve noncanonical original formatting in this fixture.
  files.set(c.context_id+'.result.json',Buffer.from(JSON.stringify(result,null,2)+'\n'));files.set(c.context_id+'.exit.json',Buffer.from(JSON.stringify(exit,null,2)+'\n'));
 }return {files,row:{model_checksum:model}};
}
test('current preparations reuse exactly six verbatim originals and require 101 fresh executions for the full 107 census',()=>{
 const {files,row}=inheritedFixture(),output=new Map();let executions=0,imports=0;
 for(let offset=0;offset<107;offset++){
  const c=pinned.contexts[offset]||{context_id:offset.toString(16).padStart(64,'0'),request_sha256:hex};
  const inherited=inheritedEvidence(pinned,files,offset,c.context_id,c.request_sha256,row);
  if(inherited){imports++;for(const name of inherited)output.set(name,files.get(name));}else executions++;
 }
 assert.equal(imports,6);assert.equal(executions,101);assert.equal(imports+executions,107);for(const [name,bytes]of output)assert.equal(bytes,files.get(name));
 const c=pinned.contexts[0];assert.throws(()=>inheritedEvidence(pinned,files,0,c.context_id,hex,row));assert.throws(()=>inheritedEvidence(pinned,files,0,hex,c.request_sha256,row));assert.throws(()=>inheritedEvidence(pinned,files,0,c.context_id,c.request_sha256,{model_checksum:hex}));assert.throws(()=>inheritedEvidence(pinned,files,6,c.context_id,c.request_sha256,row));
 for(const change of [{exit_code:1},{image_id:image},{stage_run:'1'},{candidate_sha:sha}]){const bad=new Map(files),name=c.context_id+'.exit.json';bad.set(name,Buffer.from(JSON.stringify({...JSON.parse(files.get(name)),...change})));assert.throws(()=>inheritedEvidence(pinned,bad,0,c.context_id,c.request_sha256,row));}
});
test('sanitized failure retains phase/context/offset, distinguishes host refusal from actual native exit, and never leaks stderr',()=>{
 const secret='https://secret.example/token?sig=do-not-print';
 const lock=commandFacts({status:75,stderr:'Existing release lock is busy\n'+secret});assert.equal(lock.ssh_exit,75);assert.equal(lock.native_exit,null);assert.equal(lock.host_code,'host_lock_busy');
 const native=commandFacts({status:1,stderr:'PUBLIC215_PREFLIGHT_WORKER_TERMINAL\nPUBLIC215_NATIVE_EXIT=1\n'+secret});assert.equal(native.native_exit,1);assert.equal(native.native_code,'PUBLIC215_PREFLIGHT_WORKER_TERMINAL');
 assert.equal(commandFacts({status:0,stderr:'PUBLIC215_NATIVE_EXIT=0\n'}).native_exit,0);
 assert.equal(commandFacts({status:1,stderr:'PUBLIC215_PREFLIGHT_LINUX_NODE22_REQUIRED\n'}).native_code,'PUBLIC215_PREFLIGHT_LINUX_NODE22_REQUIRED');
 assert.equal(commandFacts({status:1,stderr:'PUBLIC215_NATIVE_EXIT=1\nPUBLIC215_NATIVE_EXIT=0\n'}).native_exit,null);
 assert.equal(commandFacts({status:null,error:{code:'ETIMEDOUT'},signal:'SIGTERM'}).errno,'ETIMEDOUT');
 assert.equal(commandFacts({status:1,stderr:'PUBLIC215_PREFLIGHT_SECRET_VALUE\n'}).native_code,null);
 const evidence=failureEvidence(Error(secret),{phase:'native',offset:6,context_id:hex,request_sha256:hex});assert.equal(evidence.offset,6);assert.equal(evidence.code,'contract_refused');assert.doesNotMatch(JSON.stringify(evidence),/secret|sig=|do-not-print/);
});
test('a failed final health read cannot replace the primary native failure',async()=>{
 const primary=Error('primary'),secondary=Error('secondary'),observed=[];
 await assert.rejects(preservePrimary(async()=>{throw primary;},async()=>{throw secondary;},e=>observed.push(e)),e=>e===primary);assert.deepEqual(observed,[secondary]);
 await assert.rejects(preservePrimary(async()=>{},async()=>{throw secondary;},()=>assert.fail()),e=>e===secondary);
});
test('owned contract labels remain actionable while arbitrary errors and failed secondary writes stay redacted',async()=>{
 let refusal;try{resumeSelection({...inputs,dataset:pinned.dataset},pinned.server_tree,pinned.serving_sha,pinned.image_id);}catch(error){refusal=error;}
 assert.match(refusal.message,/Explicit R7 continuation identity differs/);const evidence=failureEvidence(refusal,{phase:'resume',offset:null,context_id:null,request_sha256:null});assert.equal(evidence.facts.contract,'Explicit R7 continuation identity differs');
 const primary=Error('untrusted failure');await assert.rejects(preservePrimary(async()=>{throw primary;},async()=>{throw Error('post-health');},()=>{throw Error('disk');}),e=>e===primary);
 assert.equal(failureEvidence(primary,{phase:'native'}).secondary_evidence_unavailable,true);
});

const corrected=CORRECTED_R7_RESUME_HANDOFF;
test('corrected79 continuation admits only the closed new dataset/provider/source/image and preserves old6',()=>{
 const selected={dataset:corrected.dataset,candidate_sha:corrected.candidate_sha,stage_run:corrected.stage_run,image_id:RESOLVE_EXISTING_IMAGE};
 assert.equal(resumeSelection(selected,corrected.server_tree,corrected.serving_sha,corrected.image_id),corrected);
 assert.equal(corrected.files.length,479);assert.equal(corrected.contexts.length,79);assert.deepEqual(corrected.contexts.map(c=>c.offset),Array.from({length:79},(_,i)=>i));
 for(const values of [[sha,corrected.serving_sha,corrected.image_id],[corrected.server_tree,sha,corrected.image_id],[corrected.server_tree,corrected.serving_sha,image]])assert.throws(()=>resumeSelection(selected,...values));
 for(const change of [{candidate_sha:sha},{stage_run:'1'}])assert.throws(()=>resumeSelection({...selected,...change},corrected.server_tree,corrected.serving_sha,corrected.image_id));
 const f=providerFixture(corrected);resumeProvider(corrected,f.run,f.jobs,f.artifact);
 for(const change of [{run_attempt:2},{status:'in_progress'},{conclusion:'success'},{head_sha:sha}])assert.throws(()=>resumeProvider(corrected,{...f.run,...change},f.jobs,f.artifact));
 assert.throws(()=>resumeProvider(corrected,f.run,f.jobs,{...f.artifact,digest:'sha256:'+hex}));
 assert.equal(pinned.contexts.length,6);assert.equal(pinned.files.length,16);
});
function correctedBoundaryFixture(){
 const files=new Map(),put=(n,v)=>files.set(n,Buffer.from(JSON.stringify(v)));
 put('failure.json',{format:'public215_linux_preflight_failure_v2',status:'incomplete_unqualified_no_freeze_or_activation',phase:'preparation',offset:79,context_id:null,request_sha256:null,code:'preparation_http',facts:{http_status:500},secondary_evidence_unavailable:false});
 put('attempt-79.started.json',{phase:'preparation',offset:79,context_id:null,request_sha256:null,observedAt:'2026-10-31T07:51:15.711Z'});
 for(const c of corrected.contexts){
  const common={offset:c.offset,context_id:c.context_id,request_sha256:c.request_sha256};
  put(`attempt-${c.offset}.bound.json`,{...common,phase:'request'});put(`attempt-${c.offset}.terminal.json`,{...common,phase:'result',status:'actual_ssh_and_native_exit0'});
  put(`attempt-${c.offset}.native-terminal.json`,{...common,phase:'native',command_exit:0,ssh_exit:0,native_exit:0,errno:null,host_code:null,http_status:null,native_code:null,signal:null});
  put(c.context_id+'.exit.json',{exit_code:0,context_id:c.context_id,request_sha256:c.request_sha256,candidate_sha:corrected.candidate_sha,image_id:corrected.image_id,stage_run:corrected.stage_run,observedAt:'2026-10-31T07:50:00Z'});
 }return files;
}
test('corrected79 inherits only actual79 native zeros and offset79 failed before binding or native execution',()=>{
 const files=correctedBoundaryFixture();correctedResumeBoundary(corrected,files);
 const change=(name,patch)=>{const f=new Map(files);f.set(name,Buffer.from(JSON.stringify({...JSON.parse(f.get(name)),...patch})));return f;};
 for(const patch of [{offset:78},{phase:'native'},{code:'command_exit'},{facts:{http_status:502}},{context_id:hex},{request_sha256:hex},{format:'public215_linux_preflight_failure_v1'}])assert.throws(()=>correctedResumeBoundary(corrected,change('failure.json',patch)));
 for(const kind of ['bound','native-terminal','terminal']){const f=new Map(files);f.set(`attempt-79.${kind}.json`,Buffer.from('{}'));assert.throws(()=>correctedResumeBoundary(corrected,f));}
 for(const patch of [{native_exit:1},{native_exit:null},{ssh_exit:1},{command_exit:null},{host_code:'host_lock_busy'}])assert.throws(()=>correctedResumeBoundary(corrected,change('attempt-78.native-terminal.json',patch)));
 assert.throws(()=>correctedResumeBoundary(corrected,change('attempt-0.terminal.json',{status:'inherited_exact_original_exit0'})));
 assert.throws(()=>correctedResumeBoundary(corrected,change(corrected.contexts[78].context_id+'.exit.json',{request_sha256:hex})));
});
test('closed479 ZIP inventory is accepted but478or480 and substituted members are refused',()=>{
 const f=zipFixture('valid',479);assert.equal(resumeArchiveFiles(f.bytes,f.m).size,479);
 for(const count of [478,480]){const bad=zipFixture('valid',count);assert.throws(()=>resumeArchiveFiles(bad.bytes,bad.m));}
 const changed=structuredClone(f.m);changed.files[478].bytes++;assert.throws(()=>resumeArchiveFiles(f.bytes,changed));
});
test('corrected79 current request/model bindings reuse79 originals and require28 fresh contexts',()=>{
 const model='d'.repeat(64),files=new Map();
 for(const c of corrected.contexts){const receipt={dataset_id:corrected.dataset,model_checksum:model};files.set(c.context_id+'.result.json',Buffer.from(JSON.stringify({format:'public_hist215_preflight_result_v1',receipt,receipt_checksum:digest(receipt),execution_ms_f64:'3ff0000000000000',peak_rss_bytes:1024})));files.set(c.context_id+'.exit.json',correctedBoundaryFixture().get(c.context_id+'.exit.json'));}
 let imported=0,fresh=0;for(let i=0;i<107;i++){const c=corrected.contexts[i]||{context_id:i.toString(16).padStart(64,'0'),request_sha256:hex};if(inheritedEvidence(corrected,files,i,c.context_id,c.request_sha256,{model_checksum:model}))imported++;else fresh++;}
 assert.equal(imported,79);assert.equal(fresh,28);
 const c=corrected.contexts[78];assert.throws(()=>inheritedEvidence(corrected,files,78,c.context_id,hex,{model_checksum:model}));assert.throws(()=>inheritedEvidence(corrected,files,78,c.context_id,c.request_sha256,{model_checksum:hex}));assert.throws(()=>inheritedEvidence(corrected,files,79,c.context_id,c.request_sha256,{model_checksum:model}));
});
