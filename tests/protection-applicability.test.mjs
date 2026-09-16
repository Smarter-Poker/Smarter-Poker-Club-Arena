import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,copyFileSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertProtection} from '../scripts/ci/assert-money-trigger-protection.mjs';
const app='123';
const rule=()=>({target:'branch',enforcement:'active',bypass_actors:[],conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},rules:[{type:'required_status_checks',parameters:{required_status_checks:[{context:'Money trigger declaration authority',integration_id:123}]}}]});
test('applicable exact main branch with exact source accepted',()=>assert.doesNotThrow(()=>assertProtection(rule(),app)));
test('unresolved default branch selector alone refused',()=>{const r=rule();r.conditions.ref_name.include=['~DEFAULT_BRANCH'];assert.throws(()=>assertProtection(r,app),/main branch rule/)});
for(const exclude of [['refs/heads/main'],['refs/heads/*'],['~ALL'],['refs/heads/other']])test('nonempty exclusion refused '+exclude,()=>{const r=rule();r.conditions.ref_name.exclude=exclude;assert.throws(()=>assertProtection(r,app),/zero exclusions/)});
for(const target of ['tag','push',undefined])test('nonbranch target refused '+target,()=>{const r=rule();r.target=target;assert.throws(()=>assertProtection(r,app),/main branch rule/)});
for(const mutate of [r=>delete r.conditions,r=>delete r.conditions.ref_name.exclude,r=>r.conditions.ref_name.include=['refs/heads/other'],r=>r.enforcement='evaluate',r=>r.bypass_actors=[{actor_id:1}],r=>delete r.bypass_actors])test('incomplete or inapplicable protection refused '+String(mutate),()=>{const r=rule();mutate(r);assert.throws(()=>assertProtection(r,app))});
test('wrong reporting app refused',()=>assert.throws(()=>assertProtection(rule(),'124'),/exact-source/));
test('missing required context refused',()=>{const r=rule();r.rules=[];assert.throws(()=>assertProtection(r,app),/exact-source/)});

// Execute the real wrapper and configuration guard, with inert ordinary/manual
// child commands and an in-process HTTP fixture. No token, dispatch or DB access.
function caller({status=1,protection=rule(),appId=app,httpStatus=200,manual=false,signal=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'money-trigger-caller-'));
 try{
  for(const name of ['check-money-trigger-with-recovery.mjs','assert-money-trigger-protection.mjs'])copyFileSync(new URL('../scripts/ci/'+name,import.meta.url),join(dir,name));
  writeFileSync(join(dir,'check-money-trigger-declared.mjs'),signal?"process.kill(process.pid,'SIGTERM');":`if(process.argv.slice(2).join(',')!=='fixture-base')throw Error('ordinary arguments changed');process.exit(${status});`);
  writeFileSync(join(dir,'await-money-trigger-proof.mjs'),"console.log('MANUAL_PROOF_CALLED');");
  writeFileSync(join(dir,'http-fixture.mjs'),`globalThis.fetch=async(url,options)=>{if(url!=='https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/rulesets/21163380')throw Error('unexpected authority endpoint');console.log('CONFIGURATION_READ');return {ok:${httpStatus===200},json:async()=>(${JSON.stringify(protection)})};};`);
  return spawnSync(process.execPath,[join(dir,'check-money-trigger-with-recovery.mjs'),...(manual?[]:['--required-authority']),'fixture-base'],{encoding:'utf8',env:{PATH:process.env.PATH,NODE_OPTIONS:'--import='+join(dir,'http-fixture.mjs'),GITHUB_REPOSITORY:'Smarter-Poker/Smarter-Poker-Club-Arena',MONEY_TRIGGER_REPORTER_APP_ID:appId}});
 }finally{rmSync(dir,{recursive:true,force:true})}
}
test('CI ordinary success stays success without configuration or manual proof',()=>{const r=caller({status:0});assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stdout,/CONFIGURATION_READ|DEFERRED|MANUAL_PROOF/)});
test('CI unreadable diff and abnormal ordinary termination never defer',()=>{for(const opts of [{status:2},{signal:true}]){const r=caller(opts);assert.equal(r.status,2,r.stderr);assert.doesNotMatch(r.stdout,/CONFIGURATION_READ|DEFERRED|MANUAL_PROOF/)}});
test('CI configured exact authority returns distinct deferral, never ordinary or manual success',()=>{const r=caller();assert.equal(r.status,3,r.stderr);assert.match(r.stdout,/CONFIGURATION_READ/);assert.match(r.stdout,/DEFERRED - ordinary declaration refused/);assert.doesNotMatch(r.stdout,/MANUAL_PROOF_CALLED/)});
test('CI refuses missing, mismatched, bypassable or unreadable authority configuration',()=>{
 const missing=rule();missing.rules=[];
 const bypass=rule();bypass.bypass_actors=[{actor_id:1}];
 for(const opts of [{appId:''},{appId:'124'},{protection:missing},{protection:bypass},{httpStatus:403}]){const r=caller(opts);assert.equal(r.status,1,r.stderr);assert.doesNotMatch(r.stdout,/DEFERRED|MANUAL_PROOF_CALLED/)}
});
test('local pre-push retains its existing manual proof route only for ordinary refusal',()=>{const r=caller({manual:true});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/MANUAL_PROOF_CALLED/);assert.doesNotMatch(r.stdout,/CONFIGURATION_READ|DEFERRED/)});
// Execute the maintained step body with inert node children, so status 3 cannot
// silently become an ordinary PASS or swallow a status 1/2 failure in its shell.
test('required CI step executes these regressions and reports deferral separately',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const step=workflow.split('      - name: Supabase Invariants - A Money Trigger Declares Itself\n')[1].split('\n      # NO BAND-AIDS')[0];
 assert.match(step,/GITHUB_TOKEN: \$\{\{ github.token \}\}/);
 assert.match(step,/MONEY_TRIGGER_REPORTER_APP_ID: \$\{\{ vars.MONEY_TRIGGER_REPORTER_APP_ID \}\}/);
 assert.doesNotMatch(step,/secrets\.|await-money-trigger-proof|consume-money-trigger-recovery/);
 const body=step.split('        run: |\n')[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
 const dir=mkdtempSync(join(tmpdir(),'money-trigger-step-'));
 try{
  for(const status of [0,1,2,3]){
   const summary=join(dir,'summary-'+status);
   const stub=`node(){ if [ "$1" = "--test" ]; then [ "$*" = "--test tests/protection-applicability.test.mjs tests/producer-boundary.test.mjs tests/money-trigger-recovery.test.mjs" ]; else [ "$*" = "scripts/ci/check-money-trigger-with-recovery.mjs --required-authority" ] || return 99; return ${status}; fi; }`;
   const r=spawnSync('bash',['--noprofile','--norc','-e','-c',stub+'\n'+body],{encoding:'utf8',env:{PATH:process.env.PATH,GITHUB_STEP_SUMMARY:summary}});
   assert.equal(r.status,status===0||status===3?0:1,r.stderr);
   const text=readFileSync(summary,'utf8');
   if(status===0)assert.match(text,/OK - every trigger/);
   else assert.doesNotMatch(text,/OK - every trigger/);
   if(status===3)assert.match(text,/DEFERRED[\s\S]*not a declaration or live-catalog pass[\s\S]*no late-CI artifact/);
   if(status===2)assert.match(text,/COULD NOT TELL/);
  }
 }finally{rmSync(dir,{recursive:true,force:true})}
});
