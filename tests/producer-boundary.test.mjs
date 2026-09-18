import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
const script=new URL('../scripts/ci/produce-money-trigger-recovery.mjs',import.meta.url);
const env={PATH:process.env.PATH,GITHUB_REPOSITORY:'Smarter-Poker/Smarter-Poker-Club-Arena',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main'};
const run=(e)=>spawnSync(process.execPath,[script.pathname],{env:{...env,...e},encoding:'utf8'});
const bundle=x=>deflateSync(JSON.stringify(x)).toString('base64');
test('untrusted dispatch ref refuses before credential use',()=>{const r=run({GITHUB_REF:'refs/heads/evil'});assert.notEqual(r.status,0);assert.match(r.stderr,/approved main/)});
test('oversized bundle refuses',()=>assert.notEqual(run({CANDIDATE_BUNDLE:'a'.repeat(48001)}).status,0));
test('path escape refuses',()=>{const r=run({CANDIDATE_BUNDLE:bundle({headSha:'a'.repeat(40),files:[{path:'../../x',sql:'x'}]})});assert.match(r.stderr,/invalid file data/)});
test('unreviewed SQL never gets a local success receipt',()=>{const r=run({CANDIDATE_BUNDLE:bundle({headSha:'a'.repeat(40),files:[{path:'supabase/migrations/20260101000000_x.sql',sql:'CREATE TRIGGER x BEFORE INSERT ON public.wallets FOR EACH ROW EXECUTE FUNCTION f();'}]})});assert.notEqual(r.status,0)});
test('candidate SQL is data, never executed',()=>{const dir=fs.mkdtempSync(path.join(path.dirname(script.pathname),'test-output-'));try{const r=spawnSync(process.execPath,[script.pathname],{cwd:dir,env:{...env,GITHUB_OUTPUT:path.join(dir,'output'),GITHUB_RUN_ID:'1',CANDIDATE_BUNDLE:bundle({headSha:'a'.repeat(40),files:[{path:'supabase/migrations/20260101000000_x.sql',sql:"SELECT '$(touch never-created)';"}]})},encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(path.join(dir,'never-created')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'money-trigger-recovery.json'))).headSha,'a'.repeat(40))}finally{fs.rmSync(dir,{recursive:true,force:true})}});

// Execute the real trusted producer with an isolated, closed GitHub transport.
// Candidate SQL is never executed; no database request is allowed by this fixture.
function pullRequest(kind) {
 const dir=fs.mkdtempSync(path.join(path.dirname(script.pathname),'test-output-'));
 try {
  const harness=`
   import fs from 'node:fs';
   import {createHash} from 'node:crypto';
   const kind=${JSON.stringify(kind)},head='a'.repeat(40),root='https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/';
   const file='supabase/migrations/20260918122532_large_record.sql';
   const sql='-- '+ 'x'.repeat(kind==='blob'?1100000:1000950)+'\\nSELECT 1;';
   const bytes=Buffer.from(sql),sha=createHash('sha1').update('blob '+bytes.length+'\\0').update(bytes).digest('hex');
   const policy=JSON.parse(fs.readFileSync(${JSON.stringify(new URL('../scripts/ci/money-trigger-recovery-policy.json',import.meta.url).pathname)},'utf8'));
   const declarationPaths=new Set(policy.map(p=>'supabase/migrations/'+p.declarationVersion+'_'+p.declarationName+'.sql'));
   let prReads=0,blobReads=0;
   globalThis.fetch=async(url,init={})=>{
    if(init.method && init.method!=='GET')throw Error('write forbidden');
    if(init.headers.Authorization!=='Bearer modeled-reader')throw Error('wrong identity');
    if(!url.startsWith(root))throw Error('untrusted host');
    const route=url.slice(root.length);let data;
    if(route==='pulls/7')data={state:'open',base:{ref:'main'},head:{sha:++prReads===2&&kind==='advanced'?'b'.repeat(40):head}};
    else if(route==='pulls/7/files?per_page=100&page=1')data=[{status:'added',filename:file}];
    else if(route==='contents/'+file+'?ref='+head){
     data={type:'file',path:file,sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')};
     if(kind==='blob'){data.encoding='none';data.content='';data.download_url='https://evil.invalid/leak';}
     if(kind==='oversized')data.size=5000001;
     if(kind==='truncated')data.content=bytes.subarray(0,-1).toString('base64');
     if(kind==='bad-hash')data.sha='b'.repeat(40);
     if(kind==='bad-base64')data.content='!'+data.content;
     if(kind==='bad-size')data.size=-1;
    }else if(route==='git/blobs/'+sha&&kind==='blob'){
     blobReads++;data={sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')};
    }else if(route.startsWith('contents/')&&route.endsWith('?ref='+head)&&declarationPaths.has(route.slice(9,-45))){
     const content=Buffer.from('SELECT 1;');
     data={type:'file',size:content.length,sha:createHash('sha1').update('blob '+content.length+'\\0').update(content).digest('hex'),encoding:'base64',content:content.toString('base64')};
    }else throw Error('unexpected request '+route);
    return {ok:true,json:async()=>data};
   };
   await import(${JSON.stringify(script.href)});
   const proof=JSON.parse(fs.readFileSync('money-trigger-recovery.json'));
   if(proof.recordHashes[file]!==createHash('sha256').update(bytes).digest('hex'))throw Error('incomplete proof');
   if(kind==='blob'&&blobReads!==1)throw Error('blob not read once');
   console.log('full migration verified');
  `;
  return spawnSync(process.execPath,['--input-type=module','-e',harness],{cwd:dir,env:{...env,GITHUB_EVENT_NAME:'pull_request_target',PR_NUMBER:'7',GITHUB_TOKEN:'modeled-reader',GITHUB_OUTPUT:path.join(dir,'output'),GITHUB_RUN_ID:'1'},encoding:'utf8',timeout:10000});
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
}
for(const kind of ['inline','blob'])test('trusted PR producer verifies complete large migration: '+kind,()=>{
 const r=pullRequest(kind);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/full migration verified/);
});
for(const kind of ['oversized','truncated','bad-hash','bad-base64','bad-size','advanced'])test('trusted PR producer refuses '+kind,()=>{
 const r=pullRequest(kind);assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout,/full migration verified/);
 assert.match(r.stderr,kind==='advanced'?/PR advanced/:/invalid|mismatch|limit/i);
});
