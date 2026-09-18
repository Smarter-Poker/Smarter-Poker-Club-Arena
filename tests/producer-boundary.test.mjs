import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
const script=new URL('../scripts/ci/produce-money-trigger-recovery.mjs',import.meta.url);
const env={PATH:process.env.PATH,GITHUB_REPOSITORY:'Smarter-Poker/Smarter-Poker-Club-Arena',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main'};
const run=(e)=>spawnSync(process.execPath,[script.pathname],{env:{...env,...e},encoding:'utf8'});
const bundle=x=>deflateSync(JSON.stringify(x)).toString('base64');
test('untrusted dispatch ref refuses before credential use',()=>{const r=run({GITHUB_REF:'refs/heads/evil'});assert.notEqual(r.status,0);assert.match(r.stderr,/approved main/)});
test('oversized bundle refuses',()=>assert.notEqual(run({CANDIDATE_BUNDLE:'a'.repeat(48001)}).status,0));
test('path escape refuses',()=>{const r=run({CANDIDATE_BUNDLE:bundle({headSha:'a'.repeat(40),files:[{path:'../../x',sql:'x'}]})});assert.match(r.stderr,/invalid file data/)});
test('unreviewed SQL never gets a local success receipt',()=>{const r=run({CANDIDATE_BUNDLE:bundle({headSha:'a'.repeat(40),files:[{path:'supabase/migrations/20260101000000_x.sql',sql:'CREATE TRIGGER x BEFORE INSERT ON public.wallets FOR EACH ROW EXECUTE FUNCTION f();'}]})});assert.notEqual(r.status,0)});
test('candidate SQL is data, never executed',()=>{const dir=fs.mkdtempSync(path.join(path.dirname(script.pathname),'test-output-'));try{const r=spawnSync(process.execPath,[script.pathname],{cwd:dir,env:{...env,GITHUB_OUTPUT:path.join(dir,'output'),GITHUB_RUN_ID:'1',CANDIDATE_BUNDLE:bundle({headSha:'a'.repeat(40),files:[{path:'supabase/migrations/20260101000000_x.sql',sql:"SELECT '$(touch never-created)';"}]})},encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(path.join(dir,'never-created')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'money-trigger-recovery.json'))).headSha,'a'.repeat(40))}finally{fs.rmSync(dir,{recursive:true,force:true})}});

const headSha='a'.repeat(40);
const migration='supabase/migrations/20260101000000_transport_boundary.sql';
const policy=JSON.parse(fs.readFileSync(new URL('../scripts/ci/money-trigger-recovery-policy.json',import.meta.url),'utf8'));
const declaration=`supabase/migrations/${policy[0].declarationVersion}_${policy[0].declarationName}.sql`;
// Run the maintained producer. The closed transport cannot contact GitHub or
// Supabase; only harmless SQL comments cross the actual input/hash boundary.
function produce({mode='pr',size,record=false,metadata={},advanced=false}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'money-producer-boundary-'));
 const sql='--'+ 'x'.repeat(size-2);
 const input={headSha,files:[{path:migration,sql:record?'-- ordinary migration':sql}],records:record?{[declaration]:sql}:{}};
 try{
  fs.writeFileSync(path.join(dir,'fixture.json'),JSON.stringify({input,metadata,advanced}));
  const harness=`
   import fs from 'node:fs';
   const {input,metadata,advanced}=JSON.parse(fs.readFileSync('fixture.json','utf8'));
   const records={...input.records,...Object.fromEntries(input.files.map(f=>[f.path,f.sql]))};
   let reads=0;
   globalThis.fetch=async url=>{
    const prefix='https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/';
    if(!url.startsWith(prefix))throw Error('unexpected transport');
    const p=url.slice(prefix.length);let value;
    if(p==='pulls/1')value={state:'open',base:{ref:'main'},head:{sha:advanced&&reads++?'b'.repeat(40):input.headSha}};
    else if(p==='pulls/1/files?per_page=100&page=1')value=input.files.map(f=>({status:'added',filename:f.path}));
    else if(p.startsWith('contents/')&&p.endsWith('?ref='+input.headSha)){
     const file=p.slice(9,-45);const sql=records[file]??'-- trusted declaration fixture';
     value={type:'file',encoding:'base64',size:Buffer.byteLength(sql),content:Buffer.from(sql).toString('base64'),...(file in records?metadata:{})};
    }else throw Error('unexpected GitHub request '+p);
    return {ok:true,json:async()=>value};
   };
   await import(${JSON.stringify(script.href)});
  `;
  const r=spawnSync(process.execPath,['--input-type=module','-e',harness],{
   cwd:dir,encoding:'utf8',timeout:10000,
   env:{...env,GITHUB_EVENT_NAME:mode==='pr'?'pull_request_target':'workflow_dispatch',PR_NUMBER:'1',GITHUB_TOKEN:'synthetic-local-only',GITHUB_RUN_ID:'1',GITHUB_OUTPUT:path.join(dir,'output'),...(mode==='dispatch'?{CANDIDATE_BUNDLE:bundle(input)}:{})},
  });
  assert.equal(r.error,undefined);
  const receipt=path.join(dir,'money-trigger-recovery.json');
  return {...r,proof:fs.existsSync(receipt)?JSON.parse(fs.readFileSync(receipt,'utf8')):null,sql};
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
}

for(const mode of ['pr','dispatch'])for(const record of [false,true]){
 for(const size of [1000956,1048576])test(`${mode} ${record?'declaration':'migration'} preserves all ${size} bytes`,()=>{
  const r=produce({mode,size,record});assert.equal(r.status,0,r.stderr);
  assert.equal(r.proof.headSha,headSha);
  assert.equal(r.proof.recordHashes[record?declaration:migration],createHash('sha256').update(r.sql).digest('hex'));
 });
 test(`${mode} ${record?'declaration':'migration'} refuses above one MiB`,()=>{
  const r=produce({mode,size:1048577,record});assert.notEqual(r.status,0);assert.equal(r.proof,null);
  assert.match(r.stderr,/invalid (migration|declaration record|record data|file data)/);
 });
}
for(const metadata of [{type:'dir'},{encoding:'none'}])test(`PR refuses unsupported contents ${JSON.stringify(metadata)}`,()=>{
 const r=produce({size:32,metadata});assert.notEqual(r.status,0);assert.equal(r.proof,null);assert.match(r.stderr,/invalid migration data/);
});
test('PR cannot certify a head that advances during verification',()=>{
 const r=produce({size:32,advanced:true});assert.notEqual(r.status,0);assert.equal(r.proof,null);assert.match(r.stderr,/PR advanced/);
});
test('dispatch still refuses an inflated bundle over five million bytes',()=>{
 const files=Array.from({length:5},(_,i)=>({path:`supabase/migrations/2026010100000${i}_large.sql`,sql:'--'+'x'.repeat(1000000)}));
 const r=run({CANDIDATE_BUNDLE:bundle({headSha,files})});assert.notEqual(r.status,0);assert.match(r.stderr,/maxOutputLength|larger than/);
});
