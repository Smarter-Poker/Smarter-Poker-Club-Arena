import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {boundedJobLog,boundedSourceReaders,sourceCommandFailure,collectSourceAdmission,immutableClassification,sourceRequirements} from './public215-source-admission.mjs';

const candidate='a'.repeat(40),head='b'.repeat(40),parent='c'.repeat(40),base='d'.repeat(40);
const names=['TypeScript Check','Client Unit Tests (vitest)','Server Engine (typecheck + tests)','Money trigger declaration authority','Production Build','CSS Beat E2E (multi-table + animations)'];
const selection={candidate_sha:candidate,stage_run:'123'};
function fixture(){
 const pr={number:7,state:'closed',merged:true,merged_at:'2026-10-30T00:00:00Z',merge_commit_sha:candidate,head:{sha:head,repo:{id:1132369872}},base:{ref:'main',repo:{id:1132369872}}};
 const ci={id:1,workflow_id:10,head_sha:head,path:'.github/workflows/ci.yml',event:'pull_request',check_suite_id:20,status:'completed',conclusion:'success'};
 const stage={id:123,workflow_id:11,head_sha:candidate,path:'.github/workflows/auto-deploy-hetzner.yml',event:'repository_dispatch',head_branch:'main',display_title:'Engine Release '+candidate,check_suite_id:21,status:'completed',conclusion:'cancelled',repository:{id:1132369872},head_repository:{id:1132369872}};
 const jobs=[...Array.from({length:4},(_,i)=>`Test The Exact Engine Release Request (shard ${i+1}/4)`),'Prove The Exact Engine Has Every Production Door','Publish Through Hetzner Club Arena','Record The Append-Only Engine Release Receipt'].map((name,i)=>({id:100+i,run_id:123,head_sha:candidate,name,status:'completed',conclusion:i<5?'success':'cancelled',steps:[]}));
 const checks=names.map((name,i)=>({id:200+i,head_sha:head,name,status:'completed',conclusion:i<4?'success':'skipped',app:{id:i===3?4962039:15368,slug:i===3?'money':'github-actions'},check_suite:{id:i===3?99:20}}));
 const f={pr,ci,stage,jobs,checks,pulls:[pr],headRuns:[ci],candidateRuns:[stage],classifierJobs:[{id:500,run_id:1,head_sha:head,name:'What changed',status:'completed',conclusion:'success',steps:[{name:'Run node scripts/ci/classify-ci-changes.mjs',status:'completed',conclusion:'success'}]}],rules:[{type:'required_status_checks',parameters:{required_status_checks:names.map((context,i)=>({context,...(i===3?{integration_id:4962039}:{})}))}}],paths:Buffer.from('server/src/example.ts\0docs/change.md\0'),log:`2026-10-30T00:00:00.000Z Classified 2 paths from exact base/head Git commits.\n2026-10-30T00:00:01.000Z this run is the pull request head (${head})`};
 const counted=rows=>({total_count:rows.length,workflow_runs:rows,check_runs:rows,jobs:rows});
 f.read=async path=>{
  const u=new URL(path,'https://fixture');
  if(u.pathname==='/pulls/7')return structuredClone(f.pr);
  if(u.pathname==='/rules/branches/main')return structuredClone(f.rules);
  if(u.pathname==='/actions/runs')return counted(u.searchParams.get('head_sha')===head?f.headRuns:f.candidateRuns);
  if(u.pathname===`/commits/${head}/check-runs`)return counted(f.checks);
  if(u.pathname===`/commits/${candidate}/check-runs`)return counted([]);
  if(u.pathname==='/actions/runs/1/jobs')return counted(f.classifierJobs);
  if(u.pathname==='/actions/runs/123/jobs')return counted(f.jobs);
  if(u.pathname==='/actions/runs/123')return f.stage;
  throw Error('Unexpected fixture read '+path);
 };
 f.gitCalls=[];
 f.git=args=>{
  f.gitCalls.push(args);
  if(args[0]==='fetch'){assert.deepEqual(args,['fetch','--quiet','--no-tags','origin',head]);return Buffer.alloc(0);}
  if(args[0]==='rev-parse'){assert.deepEqual(args,['rev-parse','--verify','FETCH_HEAD^{commit}']);return Buffer.from((f.fetchHead??head)+'\n');}
  if(args[0]==='rev-list')return Buffer.from(`${candidate} ${parent}\n`);
  if(args[0]==='merge-base')return Buffer.from(args[1]==='--all'?base+'\n':'');
  if(args[0]==='diff'){assert.equal(args[4],`${base}..${head}`);return f.paths;}
  throw Error('Unexpected Git operation');
 };
 f.invoke=()=>collectSourceAdmission(selection,{read:f.read,readArray:async()=>f.pulls,readLog:async()=>f.log,git:f.git});
 return f;
}

test('actual shared observer reproduces main missing contexts while merged-head component proof remains honest',async()=>{
 const f=fixture(),r=await f.invoke();
 assert.equal(r.qualified_head,head);assert.equal(r.qualified_pr,7);
 const fetched=f.gitCalls.findIndex(a=>a[0]==='fetch'),verified=f.gitCalls.findIndex(a=>a[0]==='rev-parse'),compared=f.gitCalls.findIndex(a=>a[0]==='rev-list');
 assert.ok(fetched>=0&&fetched<verified&&verified<compared);assert.equal(r.qualified_head_fetch,head);
 assert.equal(r.candidate_observation.state,'RED');assert.equal(r.candidate_observation.required_problems.length,6);
 assert.equal(r.head_observation.state,'NOT_RUN');assert.equal(r.source.not_applicable.length,2);
 assert.ok(r.source.not_applicable.every(x=>x.conclusion==='skipped'&&x.disposition==='not_applicable'));
 assert.equal(r.integration.conclusion,'cancelled');assert.equal(r.integration.publication_verified,false);
 assert.match(r.status,/not_deployed_frozen_or_certified/);
 f.stage.status='in_progress';f.stage.conclusion=null;f.jobs=f.jobs.slice(0,6);f.jobs[5].status='in_progress';f.jobs[5].conclusion=null;
 const pending=await f.invoke();assert.equal(pending.integration.status,'in_progress');assert.equal(pending.integration.publication_verified,false);
});

test('wrong, missing, ambiguous, foreign or changing protected PR identity refuses',async()=>{
 for(const change of [f=>f.pulls=[],f=>f.pulls=[f.pr,{...f.pr,number:8}],f=>f.pr.merge_commit_sha=base,f=>f.pr.merged=false,f=>f.pr.base.ref='feature',f=>f.pr.base.repo.id=1,f=>f.pr.head.repo.id=1,f=>f.pr.head.sha='wrong',f=>f.fetchHead=parent]){
  const f=fixture();change(f);await assert.rejects(f.invoke());
 }
 const f=fixture();await assert.rejects(collectSourceAdmission(selection,{read:f.read,readArray:async()=>f.pulls,readLog:async()=>f.log,git:f.git,readFresh:async()=>({...f.pr,head:{...f.pr.head,sha:parent}})}));
});

test('every current required source context/reporting identity must succeed or prove exact client N/A',async()=>{
 for(const change of [f=>f.checks.shift(),f=>f.checks[0].status='in_progress',f=>f.checks[0].conclusion='failure',f=>f.checks[3].app.id=1,f=>f.checks[0].head_sha=parent,f=>f.checks[4].conclusion='neutral',f=>f.checks[4].check_suite.id=99,f=>f.rules[0].parameters.required_status_checks.push({context:'New future gate',integration_id:55}),f=>f.checks.push({...f.checks[0],id:999,status:'queued',conclusion:null})]){
  const f=fixture();change(f);await assert.rejects(f.invoke());
 }
 assert.throws(()=>sourceRequirements([]));assert.throws(()=>sourceRequirements([{type:'required_status_checks',parameters:{required_status_checks:[{context:'x',integration_id:0}]}}]));
});

test('N/A requires independent full paths and genuine executed current-head classifier',async()=>{
 for(const change of [f=>f.paths=Buffer.from('src/page.tsx\0docs/change.md\0'),f=>f.paths=Buffer.from('server/a.ts'),f=>f.paths=Buffer.from('a\0a\0'),f=>f.log='',f=>f.log=f.log.replace(head,parent),f=>f.log=f.log.replace('Classified 2','Classified 3'),f=>f.classifierJobs[0].conclusion='failure',f=>f.ci.event='workflow_dispatch',f=>f.classifierJobs.push({...f.classifierJobs[0],id:501})]){
  const f=fixture();change(f);await assert.rejects(f.invoke());
 }
 const f=fixture();assert.throws(()=>immutableClassification(candidate,head,()=>Buffer.from(candidate+' '+parent+' '+base)));
});

test('all four exact candidate shards and Doors are mandatory; unrelated or failed publication outcomes never pass',async()=>{
 for(let i=0;i<5;i++){const f=fixture();f.jobs[i].conclusion='failure';await assert.rejects(f.invoke());}
 for(const change of [f=>f.stage.id=122,f=>f.stage.head_sha=base,f=>f.stage.repository.id=1,f=>f.jobs.push({...f.jobs[0],id:999}),f=>f.jobs[0].run_id=999,f=>f.jobs[5].conclusion='failure',f=>f.jobs.push({id:999,run_id:123,head_sha:candidate,name:'Unknown source contract',status:'completed',conclusion:'skipped',steps:[]}),f=>f.jobs[5].steps=[{conclusion:'failure'}],f=>f.jobs.push({id:999,run_id:123,head_sha:candidate,name:'Unexpected source test',status:'in_progress',conclusion:null}),f=>f.candidateRuns.push({...f.stage,id:124,workflow_id:12,status:'in_progress',conclusion:null}),f=>f.headRuns.push({...f.ci,id:2,workflow_id:12,status:'in_progress',conclusion:null})]){
  const f=fixture();change(f);await assert.rejects(f.invoke());
 }
});

test('workflow invokes the dedicated admission before SSH, and actually executes its regressions',()=>{
 const s=readFileSync(new URL('../../.github/workflows/public215-linux-preflight.yml',import.meta.url),'utf8');
 assert.match(s,/node --test scripts\/ci\/public215-linux-preflight.test.mjs scripts\/ci\/public215-source-admission.test.mjs/);
 assert.ok(s.indexOf('node scripts/ci/public215-source-admission.mjs')<s.indexOf('Establish existing pinned SSH identity'));
 assert.doesNotMatch(s,/node scripts\/ci\/pr-status.mjs/);
 assert.match(s,/git merge-base --is-ancestor/);
 for(const scope of ['contents','actions','checks','pull-requests'])assert.match(s,new RegExp('  '+scope+': read'));
 assert.doesNotMatch(s,/permissions: write-all|checks: write|pull-requests: write/);
});


test('failed metadata reads name only a canonical route and typed status, and remain fail closed',async()=>{
 const path=`/commits/${head}/check-runs?filter=all&per_page=100&page=1`;
 const result={status:1,stdout:Buffer.from('secret body'),stderr:Buffer.from('gh: API rate limit exceeded (HTTP 403)\nAuthorization: Bearer secret-token\nhttps://storage.example/signed?token=secret-url')};
 const readers=boundedSourceReaders(()=>result);
 await assert.rejects(readers.read(path),error=>{
  assert.match(error.message,/kind api_rate_limit; HTTP 403; exit 1/);
  assert.ok(error.message.includes(path));assert.doesNotMatch(error.message,/secret|Authorization|storage/);return true;
 });
 assert.equal(readers.stats().commands,1);
 for(const bad of ['repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/rules/branches/main?token=secret-url','/pulls/7\nsecret','https://evil/secret']){
  const message=sourceCommandFailure('gh',['api',bad],result);
  assert.match(message,/unrecognized route/);assert.doesNotMatch(message,/secret|Authorization|storage/);
 }
 assert.match(sourceCommandFailure('gh',['api','repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/rules/branches/main'],{status:null,error:{code:'ETIMEDOUT'},stderr:Buffer.alloc(0)}),/kind timeout; HTTP unknown; exit unavailable/);
 assert.equal(sourceCommandFailure('git',['fetch','secret'],result),'Immutable Git source command refused (exit 1)');
});


const storage='https://productionresults.blob.core.windows.net/logs/job.txt?sig=private-signed-value';
const apiLog='https://api.github.com/repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/actions/jobs/123/logs';
const redirect=location=>new Response(null,{status:302,headers:{Location:location}});
function logFixture(responses){
 const calls=[];let budget=0;
 return {calls,options:{token:'private-test-token',takeBudget:()=>budget++,fetchImpl:async(url,options)=>{calls.push({url,options});const response=responses.shift();if(response instanceof Error)throw response;return response;}},budget:()=>budget};
}

test('job log uses the exact two-leg API protocol and never forwards the token or follows another redirect',async()=>{
 const original='\ufeff2026-10-30T00:00:00.000Z genuine classifier log\n';
 const f=logFixture([redirect(storage),new Response(original)]);
 assert.equal(await boundedJobLog(123,f.options),original);assert.equal(f.budget(),2);assert.equal(f.calls.length,2);
 assert.equal(f.calls[0].url,apiLog);assert.equal(f.calls[0].options.headers.Authorization,'Bearer private-test-token');
 assert.equal(f.calls[0].options.redirect,'manual');assert.equal(f.calls[1].options.redirect,'manual');assert.deepEqual(f.calls[1].options.headers,{});
 assert.ok(f.calls.every(c=>c.options.signal instanceof AbortSignal));
 const g=logFixture([redirect(storage),redirect(storage)]);await assert.rejects(boundedJobLog(123,g.options),/stage download; HTTP 302; code expected_log/);assert.equal(g.calls.length,2);
});

test('job log refuses unsafe destinations before download and redacts all provider-controlled data',async()=>{
 for(const location of ['http://productionresults.blob.core.windows.net/log','https://user:private-test-token@productionresults.blob.core.windows.net/log','https://productionresults.blob.core.windows.net:444/log','https://evil.example/private-signed-value','https://productionresults.blob.core.windows.net.evil.example/log','/relative-private-signed-value','https://productionresults.blob.core.windows.net/log#private-signed-value']){
  const f=logFixture([redirect(location)]);await assert.rejects(boundedJobLog(123,f.options),error=>{assert.match(error.message,/code invalid_redirect/);assert.doesNotMatch(error.message,/private|evil|https?:|user/);return true;});assert.equal(f.calls.length,1);
 }
 const missing=logFixture([new Response(null,{status:302})]);await assert.rejects(boundedJobLog(123,missing.options),/invalid_redirect/);
 for(const [responses,expected]of [[[new Response('private-test-token',{status:403})],/stage api; HTTP 403/],[[redirect(storage),new Response('private-signed-value',{status:503})],/stage download; HTTP 503/]]){
  const f=logFixture(responses);await assert.rejects(boundedJobLog(123,f.options),error=>{assert.match(error.message,expected);assert.doesNotMatch(error.message,/private|sig=|https:/);return true;});
 }
});

test('job log enforces both advertised and streamed byte bounds and rejects malformed UTF8',async()=>{
 const over=16*1024*1024+1;
 for(const response of [new Response('x',{headers:{'content-length':String(over)}}),new Response(new Uint8Array(over)),new Response(new Uint8Array([0xc3,0x28]))]){
  const f=logFixture([redirect(storage),response]);await assert.rejects(boundedJobLog(123,f.options),/code (body_limit|invalid_utf8)/);assert.equal(f.calls.length,2);
 }
 const exact=logFixture([redirect(storage),new Response('x'.repeat(16*1024*1024))]);assert.equal((await boundedJobLog(123,exact.options)).length,16*1024*1024);
});

test('job log has one shared deadline and finite budget, with safe fixed transport codes',async()=>{
 const f=logFixture([]);await assert.rejects(boundedJobLog(123,{...f.options,deadline:Date.now()-1}),/code timeout/);assert.equal(f.calls.length,0);
 for(const error of [Object.assign(new Error('private-signed-value'),{cause:{code:'ECONNRESET'}}),Object.assign(new Error('private-test-token'),{name:'TimeoutError'}),new Error('https://secret/private')]){
  const g=logFixture([redirect(storage),error]);await assert.rejects(boundedJobLog(123,g.options),e=>{assert.match(e.message,/stage download; HTTP unknown; code (ECONNRESET|timeout|transport_failed)/);assert.doesNotMatch(e.message,/private|secret|https:/);return true;});assert.equal(g.calls.length,2);
 }
 let calls=0;await assert.rejects(boundedJobLog(123,{token:'private-test-token',takeBudget:()=>{throw Error('finite budget');},fetchImpl:async()=>{calls++;}}),/finite budget/);assert.equal(calls,0);
 await assert.rejects(boundedJobLog('123',f.options),/Exact classifier job identity/);await assert.rejects(boundedJobLog(123,{...f.options,token:''}),/credential unavailable/);
});


test('download streaming is aborted by the original shared log deadline',async()=>{
 const keepAlive=setTimeout(()=>{},100);
 const fetchImpl=async(url,options)=>url===apiLog?redirect(storage):new Response(new ReadableStream({start(controller){options.signal.addEventListener('abort',()=>controller.error(options.signal.reason),{once:true});}}));
 try{await assert.rejects(boundedJobLog(123,{token:'private-test-token',fetchImpl,deadline:Date.now()+25}),/stage download; HTTP 200; code timeout/);}
 finally{clearTimeout(keepAlive);}
});
