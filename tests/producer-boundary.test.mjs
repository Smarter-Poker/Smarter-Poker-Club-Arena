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
test('unreviewed SQL refuses even with a fresh catalog response',()=>{
 const preload='globalThis.fetch=async(url)=>{if(url!=="https://kuklfnapbkmacvwxktbh.supabase.co/rest/v1/rpc/fn_ci_money_trigger_recovery")throw Error("unexpected request");return {ok:true,json:async()=>({version:1,observed_at:new Date().toISOString(),history:[],triggers:[],declarations:[]})};};';
 const r=run({NODE_OPTIONS:'--import=data:text/javascript,'+encodeURIComponent(preload),SUPABASE_URL:'https://kuklfnapbkmacvwxktbh.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture-only-not-a-credential',CANDIDATE_BUNDLE:bundle({headSha:'a'.repeat(40),files:[{path:'supabase/migrations/20260101000000_x.sql',sql:'CREATE TRIGGER x BEFORE INSERT ON public.wallets FOR EACH ROW EXECUTE FUNCTION f();'}]})});
 assert.notEqual(r.status,0);assert.match(r.stderr,/no unique independently reviewed recovery contract/);
});
test('candidate SQL is data, never executed',()=>{const dir=fs.mkdtempSync(path.join(path.dirname(script.pathname),'test-output-'));try{const r=spawnSync(process.execPath,[script.pathname],{cwd:dir,env:{...env,GITHUB_OUTPUT:path.join(dir,'output'),GITHUB_RUN_ID:'1',CANDIDATE_BUNDLE:bundle({headSha:'a'.repeat(40),files:[{path:'supabase/migrations/20260101000000_x.sql',sql:"SELECT '$(touch never-created)';"}]})},encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(path.join(dir,'never-created')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'money-trigger-recovery.json'))).headSha,'a'.repeat(40))}finally{fs.rmSync(dir,{recursive:true,force:true})}});
