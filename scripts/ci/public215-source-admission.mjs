#!/usr/bin/env node
/** Component source evidence, never a deployment/certification verdict. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {commitState,readPages} from './pr-status.mjs';
import {classifyChangedPaths} from './classify-ci-changes.mjs';
import {invocation,stageAdmission} from './public215-linux-preflight.mjs';

const SHA=/^[0-9a-f]{40}$/, REPO='Smarter-Software-PIQ/Smarter-Poker-Club-Arena', REPO_ID=1132369872;
const CI='.github/workflows/ci.yml';
const PUBLICATION=new Set(['Publish Through Hetzner Club Arena','Record The Append-Only Engine Release Receipt']);
const OPTIONAL_RELEASE_JOBS=new Set(['Observe One Private Natural Horse Cohort','Withdraw One Exact Waiting Original Transaction','Dispatch Exact Cross-Artifact Production Certification']);
const CLIENT_ONLY=new Set(['Production Build','CSS Beat E2E (multi-table + animations)']);
class SourceRefusal extends Error {}
const demand=(ok,why)=>{if(!ok)throw new SourceRefusal(why);};
const positive=n=>Number.isSafeInteger(n)&&n>0;

export function sourceRequirements(rules){
 demand(Array.isArray(rules),'Readable current branch rules required');
 const result=new Map();
 for(const rule of rules.filter(r=>r.type==='required_status_checks')){
  const checks=rule.parameters?.required_status_checks;
  demand(Array.isArray(checks)&&checks.length,'Complete required context rules required');
  for(const check of checks){
   const reporter=check.integration_id??null;
   demand(typeof check.context==='string'&&check.context.length>0&&(reporter===null||positive(reporter)),'Valid context/reporter required');
   if(!result.has(check.context))result.set(check.context,new Set());
   result.get(check.context).add(reporter);
  }
 }
 demand(result.size>0,'Nonempty current required contexts required');return result;
}

export function mergedQualification(pulls,pr,candidate){
 demand(SHA.test(candidate)&&Array.isArray(pulls)&&pulls.length<=1000,'Bounded merge association required');
 demand(pulls.every(p=>positive(p.number))&&new Set(pulls.map(p=>p.number)).size===pulls.length,'Unique association inventory required');
 const exact=pulls.filter(p=>p.merge_commit_sha===candidate&&p.state==='closed'&&p.merged_at);
 demand(exact.length===1&&pr.number===exact[0].number&&pr.merged===true&&pr.state==='closed'&&pr.merged_at&&pr.merge_commit_sha===candidate,'One exact protected merged PR required');
 demand(pr.base?.ref==='main'&&pr.base.repo?.id===REPO_ID&&pr.head?.repo?.id===REPO_ID&&SHA.test(pr.head.sha)&&pr.head.sha!==candidate,'Canonical qualified PR head required');
 return pr.head.sha;
}

export function immutableClassification(candidate,head,git){
 demand(SHA.test(candidate)&&SHA.test(head),'Exact immutable comparison required');
 const parents=git(['rev-list','--parents','-n','1',candidate]).toString().trim().split(/\s+/);
 demand(parents.length===2&&parents[0]===candidate&&SHA.test(parents[1]),'One protected squash parent required');
 const mergeBase=git(['merge-base','--all',parents[1],head]).toString().trim();
 demand(SHA.test(mergeBase),'One immutable merge base required');
 const bytes=git(['diff','--name-only','--no-renames','-z',`${mergeBase}..${head}`,'--']);
 demand(Buffer.isBuffer(bytes),'Byte-framed immutable paths required');
 const text=bytes.toString('utf8');
 demand(Buffer.from(text,'utf8').equals(bytes)&&(!bytes.length||text.endsWith('\0')),'Complete UTF-8 NUL path framing required');
 const paths=bytes.length?text.slice(0,-1).split('\0'):[];
 demand(paths.length>0&&paths.every(p=>p&&!p.startsWith('/')&&!p.split('/').includes('..'))&&new Set(paths).size===paths.length,'Complete unique relative paths required');
 return {complete:true,base:parents[1],head,mergeBase,paths,flags:classifyChangedPaths(paths)};
}

export function classifierWitness(run,jobs,log,classification,head){
 demand(run?.path===CI&&run.event==='pull_request'&&run.head_sha===head&&run.status==='completed'&&run.conclusion==='success'&&positive(run.check_suite_id),'Genuine qualified CI success required');
 const matching=jobs.filter(j=>j.name==='What changed');
 demand(matching.length===1,'One executed classifier required');const job=matching[0];
 demand(job.run_id===run.id&&job.head_sha===head&&job.status==='completed'&&job.conclusion==='success','Exact successful classifier job required');
 const steps=job.steps?.filter(s=>s.name==='Run node scripts/ci/classify-ci-changes.mjs');
 demand(steps?.length===1&&steps[0].status==='completed'&&steps[0].conclusion==='success','Classifier execution required');
 demand(classification?.complete===true&&classification.head===head&&classification.flags?.src===false,'Independently complete non-client classification required');
 demand(typeof log==='string'&&Buffer.byteLength(log)<=16*1024*1024,'Bounded classifier log required');
 const actual=log.split('\n').filter(l=>/^\d{4}-\d\d-\d\dT\S+Z /.test(l));
 demand(actual.filter(l=>l.endsWith(`this run is the pull request head (${head})`)).length===1&&!actual.some(l=>l.includes(`superseded: this run is ${head},`)),'Original current-head classifier witness required');
 demand(actual.filter(l=>l.endsWith(`Classified ${classification.paths.length} paths from exact base/head Git commits.`)).length===1,'Independent path census must match executed classifier');
 return {ci_run:run.id,classifier_job:job.id,head,log_sha256:createHash('sha256').update(log).digest('hex'),classification};
}

export function qualifiedSource(observation,checks,required,witness){
 demand(observation&&Array.isArray(observation.requiredProblems)&&Array.isArray(observation.failures)&&observation.failures.length===0&&Array.isArray(observation.activeRuns)&&observation.activeRuns.length===0,'Qualified head has missing/active/failed source evidence');
 const notApplicable=[];
 for(const problem of observation.requiredProblems){
  demand(CLIENT_ONLY.has(problem.context)&&problem.state==='not_run'&&JSON.stringify(problem.conclusions)==='["skipped"]'&&witness?.classification?.complete===true&&witness.classification.flags?.src===false,'Required source context did not succeed');
  const matching=checks.filter(c=>c.name===problem.context&&((problem.integrationId??null)===null||c.app.id===problem.integrationId));
  const latest=new Map();for(const c of matching)if(!latest.has(c.app.id)||latest.get(c.app.id).id<c.id)latest.set(c.app.id,c);
  demand(latest.size===1,'One genuine skipped CI reporter required');const check=[...latest.values()][0];
  demand(check.head_sha===witness.head&&check.app.id===15368&&check.app.slug==='github-actions'&&check.check_suite?.id===witness.suite&&check.status==='completed'&&check.conclusion==='skipped','Actual latest qualified CI skip required');
  notApplicable.push({context:problem.context,check_id:check.id,reporter:check.app.id,conclusion:'skipped',disposition:'not_applicable',reason:'independently_recomputed_non_client_diff',ci_run:witness.ci_run});
 }
 demand(required instanceof Map&&required.size>0,'Current required reporters required');
 return {required:[...required].map(([context,reporters])=>({context,reporters:[...reporters]})),checks:checks.filter(c=>required.has(c.name)).map(c=>({id:c.id,head_sha:c.head_sha,name:c.name,status:c.status,conclusion:c.conclusion,reporter:c.app.id,suite:c.check_suite?.id??null})),not_applicable:notApplicable};
}

export function candidateIntegration(observation,run,jobs,candidate,stageRun){
 demand(run?.id===Number(stageRun)&&run.head_sha===candidate&&run.repository?.id===REPO_ID&&run.head_repository?.id===REPO_ID,'Exact selected release identity required');
 stageAdmission(run,jobs,candidate);
 demand(Array.isArray(jobs)&&jobs.every(j=>positive(j.id)&&j.run_id===run.id&&j.head_sha===candidate)&&new Set(jobs.map(j=>j.id)).size===jobs.length&&new Set(jobs.map(j=>j.name)).size===jobs.length,'Unique exact candidate jobs required');
 demand(observation.runs.filter(r=>r.id===run.id).length===1,'Selected release must be the observed current attempt');
 for(const active of observation.activeRuns)demand(active.id===run.id,'Other candidate workflow remains active');
 for(const failure of observation.failures)demand(failure.runId===run.id&&failure.required===false&&PUBLICATION.has(failure.job)&&failure.conclusion==='cancelled','Other candidate workflow/source failure refuses');
 for(const job of jobs){
  if(job.status==='completed'&&job.conclusion==='success')continue;
  if(job.status==='completed'&&job.conclusion==='skipped'&&OPTIONAL_RELEASE_JOBS.has(job.name))continue;
  demand(PUBLICATION.has(job.name)&&((job.status==='completed'&&job.conclusion==='cancelled')||(job.status==='in_progress'&&job.conclusion===null)),'Only selected publication activity/cancellation is separate from source');
  demand(Array.isArray(job.steps)&&job.steps.every(s=>s.conclusion===null||['success','skipped','cancelled'].includes(s.conclusion)),'Failed/unknown selected publication step refuses');
 }
 demand(['in_progress','completed'].includes(run.status)&&((run.status==='in_progress'&&run.conclusion===null)||(run.status==='completed'&&['success','cancelled'].includes(run.conclusion))),'Unknown/failed release outcome refuses');
 return {stage_run:run.id,status:run.status,conclusion:run.conclusion,publication_verified:false,meaning:'source_integration_only_not_publication',jobs:jobs.map(j=>({id:j.id,run_id:j.run_id,head_sha:j.head_sha,name:j.name,status:j.status,conclusion:j.conclusion})),publication_jobs:jobs.filter(j=>PUBLICATION.has(j.name)).map(j=>({id:j.id,name:j.name,status:j.status,conclusion:j.conclusion}))};
}

export async function collectSourceAdmission(selected,{read,readArray,readLog,git,readFresh=read}){
 git(['merge-base','--is-ancestor',selected.candidate_sha,'origin/main']);
 const pulls=await readArray(`/commits/${selected.candidate_sha}/pulls`);
 const exact=pulls.filter(p=>p.merge_commit_sha===selected.candidate_sha&&p.state==='closed'&&p.merged_at);
 demand(exact.length===1,'One associated protected squash PR required');
 const pr=await read(`/pulls/${exact[0].number}`),head=mergedQualification(pulls,pr,selected.candidate_sha);
 // A squash head need not be reachable from a fresh main-only checkout.
 git(['fetch','--quiet','--no-tags','origin',head]);
 demand(git(['rev-parse','--verify','FETCH_HEAD^{commit}']).toString().trim()===head,'Fetched qualification must match the verified exact head');
 const required=sourceRequirements(await read('/rules/branches/main'));
 const headObservation=await commitState(head,required,read);
 const checks=await readPages(`/commits/${head}/check-runs?filter=all`,'check_runs',read);
 let witness=null;
 if(headObservation.requiredProblems?.length){
  const ci=headObservation.runs.filter(r=>r.path===CI);demand(ci.length===1,'One qualified CI required');
  const jobs=await readPages(`/actions/runs/${ci[0].id}/jobs?filter=latest`,'jobs',read);
  const changed=jobs.filter(j=>j.name==='What changed');demand(changed.length===1,'One exact classifier required');
  witness={...classifierWitness(ci[0],jobs,await readLog(changed[0].id),immutableClassification(selected.candidate_sha,head,git),head),suite:ci[0].check_suite_id};
 }
 const source=qualifiedSource(headObservation,checks,required,witness);
 const candidateObservation=await commitState(selected.candidate_sha,required,read);
 const run=await read(`/actions/runs/${selected.stage_run}`);
 const jobs=await readPages(`/actions/runs/${selected.stage_run}/jobs?filter=latest`,'jobs',read);
 const integration=candidateIntegration(candidateObservation,run,jobs,selected.candidate_sha,selected.stage_run);
 const after=await readFresh(`/pulls/${pr.number}`);demand(mergedQualification(pulls,after,selected.candidate_sha)===head,'Protected qualification identity changed');
 return {format:'public215_protected_source_admission_v1',candidate_sha:selected.candidate_sha,qualified_pr:pr.number,qualified_head:head,qualified_head_fetch:head,source,classifier:witness,integration,head_observation:{state:headObservation.state,required_problems:headObservation.requiredProblems,failures:headObservation.failures,active_runs:headObservation.activeRuns},candidate_observation:{state:candidateObservation.state,required_problems:candidateObservation.requiredProblems,failures:candidateObservation.failures,active_runs:candidateObservation.activeRuns},status:'source_evidence_only_not_deployed_frozen_or_certified'};
}

// Emit only our canonical metadata route and typed failure facts. Never echo
// CLI stderr, response bodies, headers, redirects or credential-bearing URLs.
export function sourceCommandFailure(binary,args,result){
 const exit=Number.isInteger(result.status)?result.status:'unavailable';
 if(binary!=='gh')return `Immutable Git source command refused (exit ${exit})`;
 const prefix=`repos/${REPO}`,path=args.length===2&&args[0]==='api'&&args[1].startsWith(prefix)?args[1].slice(prefix.length):'';
 const allowed=/^\/(?:commits\/[0-9a-f]{40}\/(?:pulls|check-runs)|pulls\/[1-9][0-9]*|rules\/branches\/main|actions\/(?:runs(?:\/[1-9][0-9]*(?:\/jobs)?)?|jobs\/[1-9][0-9]*\/logs))(?:\?(?:(?:filter=(?:all|latest)|head_sha=[0-9a-f]{40})&)?per_page=100&page=[1-9][0-9]*)?$/;
 const route=allowed.test(path)?path:'[unrecognized route]';
 const stderr=Buffer.isBuffer(result.stderr)?result.stderr.toString('utf8'):'';
 const http=stderr.match(/\bHTTP ([1-5][0-9]{2})\b/);
 const kind=result.error?.code==='ETIMEDOUT'?'timeout':result.error?'unavailable':/\b(?:API rate limit exceeded|secondary rate limit)\b/i.test(stderr)?'api_rate_limit':'command_failed';
 return `GitHub source metadata command refused (route ${route}; kind ${kind}; HTTP ${http?.[1]??'unknown'}; exit ${exit})`;
}

const LOG_BYTES=16*1024*1024;
const LOG_CAUSES=new Set(['ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID']);
const logRefusal=(stage,status,code)=>new SourceRefusal(`Classifier log refused (stage ${stage}; HTTP ${Number.isInteger(status)&&status>=100&&status<=599?status:'unknown'}; code ${code})`);
const logCause=error=>['AbortError','TimeoutError'].includes(error?.name)?'timeout':LOG_CAUSES.has(error?.cause?.code)?error.cause.code:LOG_CAUSES.has(error?.code)?error.code:'transport_failed';

// GitHub documents a 302 to a short-lived log URL. Keep the repository token
// on the API leg only; never forward it to storage or print the signed URL.
export async function boundedJobLog(id,{fetchImpl=fetch,token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN,takeBudget=()=>{},deadline=Date.now()+120000}={}){
 demand(positive(id),'Exact classifier job identity required');
 demand(typeof token==='string'&&token.length>0,'Workflow source reader credential unavailable');
 const end=Math.min(deadline,Date.now()+20000);
 const request=async(stage,url,headers={})=>{
  takeBudget();const remaining=end-Date.now();if(remaining<=0)throw logRefusal(stage,null,'timeout');
  try{return await fetchImpl(url,{method:'GET',redirect:'manual',headers,signal:AbortSignal.timeout(remaining)});}
  catch(error){throw logRefusal(stage,null,logCause(error));}
 };
 const api=await request('api',`https://api.github.com/repos/${REPO}/actions/jobs/${id}/logs`,{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'});
 if(api.status!==302){void api.body?.cancel().catch(()=>{});throw logRefusal('api',api.status,'expected_redirect');}
 let target;
 try{target=new URL(api.headers.get('location'));}catch{throw logRefusal('api',302,'invalid_redirect');}
 finally{void api.body?.cancel().catch(()=>{});}
 if(target.protocol!=='https:'||target.username||target.password||target.port||target.hash||!(/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(target.hostname)||target.hostname==='results-receiver.actions.githubusercontent.com'))throw logRefusal('api',302,'invalid_redirect');
 const response=await request('download',target.href);
 if(response.status!==200){void response.body?.cancel().catch(()=>{});throw logRefusal('download',response.status,'expected_log');}
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>LOG_BYTES)){void response.body?.cancel().catch(()=>{});throw logRefusal('download',200,'body_limit');}
 if(!response.body)throw logRefusal('download',200,'missing_body');
 const reader=response.body.getReader(),parts=[];let size=0;
 try{
  for(;;){
   const part=await reader.read();if(part.done)break;
   if(!(part.value instanceof Uint8Array))throw logRefusal('download',200,'invalid_body');
   size+=part.value.byteLength;if(size>LOG_BYTES){void reader.cancel().catch(()=>{});throw logRefusal('download',200,'body_limit');}
   parts.push(Buffer.from(part.value));
  }
 }catch(error){if(error instanceof SourceRefusal)throw error;throw logRefusal('download',200,logCause(error));}
 finally{reader.releaseLock();}
 if(Date.now()>end)throw logRefusal('download',200,'timeout');
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(parts,size));}
 catch{throw logRefusal('download',200,'invalid_utf8');}
 if(Date.now()>end)throw logRefusal('download',200,'timeout');return text;
}

export function boundedSourceReaders(run=spawnSync,fetchImpl=fetch){
 const started=Date.now(),deadline=started+120000;let calls=0;const cache=new Map();
 const takeBudget=()=>demand(++calls<=80&&Date.now()<deadline,'Finite source admission budget exceeded');
 const command=(binary,args)=>{takeBudget();const r=run(binary,args,{encoding:null,maxBuffer:16*1024*1024,timeout:Math.min(20000,deadline-Date.now())});demand(!r.error&&r.status===0,sourceCommandFailure(binary,args,r));return r.stdout;};
 const json=path=>JSON.parse(command('gh',['api',`repos/${REPO}${path}`]).toString('utf8'));
 const read=async path=>{if(!cache.has(path))cache.set(path,json(path));return cache.get(path);};
 const readArray=async path=>{const result=[];for(let page=1;page<=10;page++){const rows=await read(`${path}?per_page=100&page=${page}`);demand(Array.isArray(rows),'Readable merge associations required');result.push(...rows);if(rows.length<100)return result;}throw Error('Unbounded merge associations');};
 return {read,readArray,readLog:async id=>boundedJobLog(id,{fetchImpl,takeBudget,deadline}),git:args=>command('git',args),readFresh:async path=>json(path),stats:()=>({commands:calls,elapsed_ms:Date.now()-started})};
}

async function main(){
 const selected=invocation(process.env,JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')));
 demand(process.env.CANDIDATE_SHA===selected.candidate_sha,'Workflow candidate binding required');
 const readers=boundedSourceReaders(),receipt=await collectSourceAdmission(selected,readers);receipt.budget=readers.stats();
 const out=resolve('artifacts/public215-linux-preflight');mkdirSync(out,{recursive:true,mode:0o700});writeFileSync(join(out,'source-admission.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('Exact protected PR qualification and candidate engine integration proved; no publication or certification verdict');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error('Protected Public215 source admission refused: '+(error instanceof SourceRefusal?error.message:'source inventory unavailable or malformed')+'; no qualification inferred');process.exitCode=1;});
