import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {invocation,stageAdmission,sourceGraph,remoteCommand,GRAPH_FILES,digest,programRequest,executionEvidence} from './public215-linux-preflight.mjs';
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
 assert.match(workflow,/node scripts\/ci\/pr-status\.mjs --sha/);assert.doesNotMatch(workflow,/schedule:|workflow_run:|auto-deploy-hetzner\.yml.*dispatch/);
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
