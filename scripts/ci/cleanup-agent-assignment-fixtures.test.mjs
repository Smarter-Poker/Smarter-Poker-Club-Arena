import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,unlinkSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {supabaseServerHeaders} from './supabase-auth-headers.mjs';
const source=readFileSync(new URL('./cleanup-agent-assignment-fixtures.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export async function','async function').replace(/^if\(process\.argv[\s\S]*$/m,'')+'\nreturn cleanupAgentAssignmentFixtures;';
const factory=new Function('assert','existsSync','readFileSync','unlinkSync','join','cleanupProductionE2EAccount','supabaseServerHeaders',source);
const run=factory(assert,existsSync,readFileSync,unlinkSync,join,()=>{throw new Error('Expected injected cleanup');},supabaseServerHeaders);
async function fixture({custody=0,personal=false}={}) {
 const root=mkdtempSync(join(tmpdir(),'agent-assignment-cleanup-'));
 const state={deleted:[],retired:[]};const agents=new Map();
 for(const i of [0,1,2]) {
  const account={id:`00000000-0000-4000-8000-00000000000${i}`,email:personal?'person@example.com':`ca-customization-cert-postdeploy-${i}@example.invalid`};
  writeFileSync(join(root,`agent-assignment-${i}.json`),JSON.stringify(account));
  if(i<2)agents.set(account.id,{id:account.id,user_id:account.id,parent_agent_id:null,...Object.fromEntries(['credit_used','credit_limit','business_balance','player_balance','promo_balance','agent_wallet_balance','player_wallet_balance','promo_wallet_balance','weekly_rake_generated','lifetime_earnings','lifetime_rake_generated'].map(key=>[key,0]))});
 }
 const fetchImpl=async(url,{method})=>{
  const u=new URL(url),id=(u.searchParams.get('user_id')||u.searchParams.get('id')||'').slice(3);let data;
  if(u.pathname==='/rest/v1/profiles')data=[{id,email:`ca-customization-cert-postdeploy-${Number(id.slice(-1))}@example.invalid`}];
  else if(u.pathname==='/rest/v1/club_members')data=u.searchParams.has('agent_id')?[]:[Object.fromEntries(['chip_balance','promo_balance','held_chips','locked_chips','credit_used','credit_limit'].map(key=>[key,custody]))];
  else if(u.pathname==='/rest/v1/agents'){if(method==='DELETE'){state.deleted.push(id);agents.delete(id);}data=u.searchParams.has('parent_agent_id')?[]:agents.has(id)?[agents.get(id)]:[];}
  else throw new Error(u.pathname);
  return {ok:true,status:200,async text(){return JSON.stringify(data)}};
 };
 const cleanupAccount=async({record})=>state.retired.push(record.id);
 return {root,state,pending:()=>run({environment:{RUNNER_TEMP:root,SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture'},fetchImpl,cleanupAccount})};
}
test('interrupted child records retire player first and only zero empty owned agents',async()=>{
 const f=await fixture();try{await f.pending();assert.deepEqual(f.state.retired.map(id=>id.slice(-1)),['2','1','0']);assert.equal(f.state.deleted.length,2);for(const i of [0,1,2])assert.equal(existsSync(join(f.root,`agent-assignment-${i}.json`)),false);}finally{rmSync(f.root,{recursive:true});}
});
for(const scenario of [{custody:1},{personal:true}])test('unsafe fallback retains records and refuses deletes '+JSON.stringify(scenario),async()=>{
 const f=await fixture(scenario);try{await assert.rejects(f.pending(),/fallback cleanup incomplete/);assert.equal(f.state.deleted.length,0);assert.equal(f.state.retired.length,0);assert.equal(existsSync(join(f.root,'agent-assignment-0.json')),true);}finally{rmSync(f.root,{recursive:true});}
});
