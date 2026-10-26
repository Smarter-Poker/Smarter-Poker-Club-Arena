import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { summarize, profileTarget, failureReason } from '../../scripts/ci/profile-engine-main-thread.mjs';

async function target(t) {
  // Keep the fixture witness out of the timers' optimized/inlined frames.
  const child=spawn(process.execPath,['--no-opt','--inspect=127.0.0.1:0','-e',
    'setInterval(function cpuSampleWitness(){ const end=Date.now()+8;while(Date.now()<end) Math.sqrt(Math.random()); },10)'],{stdio:['ignore','ignore','pipe']});
  t.after(async()=>{ if(child.exitCode===null && child.signalCode===null){child.kill();await once(child,'exit');} });
  const endpoint=await new Promise((resolve,reject)=>{
    let text='';const timer=setTimeout(()=>reject(new Error('fixture_start_timeout')),5000);
    child.stderr.on('data',d=>{text+=d;const m=text.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);if(m){clearTimeout(timer);resolve(m[0]);}});
    child.once('error',reject);
  });
  return {child,endpoint};
}

test('real V8 CPU samples are summarized and the owned inspector closes',async t=>{
  const {child,endpoint}=await target(t);
  const result=await profileTarget(endpoint,child.pid,1000);
  assert.ok(result.samples>0);assert.ok(result.sampledUs>0);
  assert.ok(result.topSelf.some(x=>x.functionName==='cpuSampleWitness'));
  assert.equal(child.exitCode,null);
  let closed=false;
  const deadline=Date.now()+2000;
  while(Date.now()<deadline && !closed){
    try { await fetch(endpoint.replace('ws:','http:').replace(/\/[^/]+$/,'/json/list')); await new Promise(r=>setTimeout(r,20)); }
    catch { closed=true; }
  }
  assert.equal(closed,true,'the owned inspector must actually stop listening');
});

test('a mismatched process is refused without closing its inspector',async t=>{
  const {child,endpoint}=await target(t);
  await assert.rejects(profileTarget(endpoint,child.pid+1,50),/profile_pid_mismatch/);
  assert.equal((await fetch(endpoint.replace('ws:','http:').replace(/\/[^/]+$/,'/json/list'))).status,200);
});

test('only loopback and bounded collection are admitted',async()=>{
  await assert.rejects(profileTarget('ws://example.com:9229/x',1,50),/profile_target_refused/);
  await assert.rejects(profileTarget('ws://127.0.0.1:9229/x',1,30001),/profile_target_refused/);
});

test('missing or invalid samples are unknown, never a successful empty profile',()=>{
  assert.throws(()=>summarize({nodes:[],samples:[],timeDeltas:[]}),/profile_samples_missing/);
  assert.throws(()=>summarize({nodes:[],samples:[1],timeDeltas:[1]}),/profile_sample_invalid/);
  const r=summarize({nodes:[{id:1,callFrame:{functionName:'witness',url:'https://private.invalid/token',lineNumber:0}}],samples:[1],timeDeltas:[50]});
  assert.equal(r.topSelf[0].file,'(runtime)');
  assert.equal(r.topSelf[0].percent,100);
});

test('a disconnected target never returns a successful profile',async t=>{
  const {child,endpoint}=await target(t);
  const timer=setTimeout(()=>child.kill(),100);
  try { await assert.rejects(profileTarget(endpoint,child.pid,300)); }
  finally { clearTimeout(timer); }
});


test('the exact stdin entry refuses invalid identity before touching a target',()=>{
  const source=readFileSync(new URL('../../scripts/ci/profile-engine-main-thread.mjs',import.meta.url),'utf8');
  const r=spawnSync(process.execPath,['--input-type=module','-','invalid-sha'],{input:source,encoding:'utf8',timeout:3000});
  assert.equal(r.status,1);assert.equal(r.stdout,'');
  assert.match(r.stderr,/^CPU profile failed; inspect owning run and inspector state before any retry\./);
  assert.match(r.stderr,/reason=expected_sha_refused/);
});

test('importing the helper from a stdin module never invokes the production entry',()=>{
  const url=new URL('../../scripts/ci/profile-engine-main-thread.mjs',import.meta.url).href;
  const r=spawnSync(process.execPath,['--input-type=module','-'],{input:'await import('+JSON.stringify(url)+'); console.log(\"imported\");',encoding:'utf8',timeout:3000});
  assert.equal(r.status,0);assert.equal(r.stderr,'');assert.equal(r.stdout.trim(),'imported');
});


test('CLI refusals name the gate without exporting arbitrary error payloads',()=>{
  assert.equal(failureReason(new Error('inspector_already_active')),'inspector_already_active');
  assert.equal(failureReason(new Error('private URL https://example.invalid/secret')),'unclassified_failure');
  assert.equal(failureReason(null),'unclassified_failure');
});
