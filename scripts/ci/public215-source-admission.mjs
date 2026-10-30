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

export function boundedSourceReaders(){
 const started=Date.now(),deadline=started+120000;let calls=0;const cache=new Map();
 const command=(binary,args)=>{demand(++calls<=80&&Date.now()<deadline,'Finite source admission budget exceeded');const r=spawnSync(binary,args,{encoding:null,maxBuffer:16*1024*1024,timeout:Math.min(20000,deadline-Date.now())});demand(!r.error&&r.status===0,`${binary==='gh'?'GitHub source metadata':'Immutable Git source'} command refused (exit ${Number.isInteger(r.status)?r.status:'unavailable'})`);return r.stdout;};
 const json=path=>JSON.parse(command('gh',['api',`repos/${REPO}${path}`]).toString('utf8'));
 const read=async path=>{if(!cache.has(path))cache.set(path,json(path));return cache.get(path);};
 const readArray=async path=>{const result=[];for(let page=1;page<=10;page++){const rows=await read(`${path}?per_page=100&page=${page}`);demand(Array.isArray(rows),'Readable merge associations required');result.push(...rows);if(rows.length<100)return result;}throw Error('Unbounded merge associations');};
 return {read,readArray,readLog:async id=>command('gh',['api',`repos/${REPO}/actions/jobs/${id}/logs`]).toString('utf8'),git:args=>command('git',args),readFresh:async path=>json(path),stats:()=>({commands:calls,elapsed_ms:Date.now()-started})};
}

async function main(){
 const selected=invocation(process.env,JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')));
 demand(process.env.CANDIDATE_SHA===selected.candidate_sha,'Workflow candidate binding required');
 const readers=boundedSourceReaders(),receipt=await collectSourceAdmission(selected,readers);receipt.budget=readers.stats();
 const out=resolve('artifacts/public215-linux-preflight');mkdirSync(out,{recursive:true,mode:0o700});writeFileSync(join(out,'source-admission.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('Exact protected PR qualification and candidate engine integration proved; no publication or certification verdict');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error('Protected Public215 source admission refused: '+(error instanceof SourceRefusal?error.message:'source inventory unavailable or malformed')+'; no qualification inferred');process.exitCode=1;});
