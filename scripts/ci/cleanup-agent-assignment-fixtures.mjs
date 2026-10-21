/** Finite fallback for this job's three durable assignment fixtures after interruption. */
import assert from 'node:assert/strict';
import {existsSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cleanupProductionE2EAccount} from './production-e2e-account.mjs';
import {supabaseServerHeaders} from './supabase-auth-headers.mjs';
export async function cleanupAgentAssignmentFixtures({environment=process.env,fetchImpl=fetch,cleanupAccount=cleanupProductionE2EAccount}={}) {
 const base=environment.SUPABASE_URL?.replace(/\/$/,'');const key=environment.SUPABASE_SERVICE_ROLE_KEY;
 const club='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';assert.ok(environment.RUNNER_TEMP && base && key);
 assert.ok(!environment.E2E_CLUB_ID || environment.E2E_CLUB_ID===club);
 async function request(path,method='GET') {
  const response=await fetchImpl(base+path,{method,headers:supabaseServerHeaders(key,{'Content-Type':'application/json',Prefer:'return=representation'})});
  assert.ok(response.ok,`Assignment cleanup ${method} refused: HTTP ${response.status}`);
  const text=await response.text();return text?JSON.parse(text):null;
 }
 function zero(row,fields){for(const field of fields){assert.ok(Object.hasOwn(row,field));assert.equal(Number(row[field]),0,field);}}
 const errors=[];
 for(const index of [2,1,0]) {
  const path=join(environment.RUNNER_TEMP,`agent-assignment-${index}.json`);if(!existsSync(path))continue;
  try {
   const account=JSON.parse(readFileSync(path,'utf8'));
   assert.match(account.id,/^[a-f0-9-]{36}$/);assert.match(account.email,/^ca-customization-cert-postdeploy-.+@example\.invalid$/);
   const profiles=await request(`/rest/v1/profiles?id=eq.${account.id}&select=id,email`);
   assert.ok(profiles.length<=1);if(profiles.length)assert.equal(profiles[0].email,account.email);
   const memberPath=`/rest/v1/club_members?club_id=eq.${club}&user_id=eq.${account.id}`;
   const members=await request(memberPath+'&select=*');assert.ok(members.length<=1);
   if(members.length)zero(members[0],['chip_balance','promo_balance','held_chips','locked_chips','credit_used','credit_limit']);
   const agentPath=`/rest/v1/agents?club_id=eq.${club}&user_id=eq.${account.id}`;
   const agents=await request(agentPath+'&select=*');assert.ok(agents.length<=1);
   for(const agent of agents) {
    assert.equal(profiles.length,1,'A fixture agent needs its verified owned profile');assert.equal(agent.parent_agent_id,null);
    assert.equal((await request(`/rest/v1/club_members?club_id=eq.${club}&agent_id=eq.${account.id}&select=user_id`)).length,0);
    assert.equal((await request(`/rest/v1/agents?club_id=eq.${club}&parent_agent_id=eq.${agent.id}&select=id`)).length,0);
    zero(agent,['credit_used','credit_limit','business_balance','player_balance','promo_balance','agent_wallet_balance','player_wallet_balance','promo_wallet_balance','weekly_rake_generated','lifetime_earnings','lifetime_rake_generated']);
    const exact=agentPath+`&id=eq.${agent.id}`;await request(exact,'DELETE');assert.equal((await request(exact+'&select=id')).length,0);
   }
   await cleanupAccount({environment:{...environment,E2E_TEST_ACCOUNT_FILE:path},fetchImpl,record:account});
   unlinkSync(path);
  }catch(error){errors.push(error);}
 }
 if(errors.length)throw new AggregateError(errors,'Assignment fixture fallback cleanup incomplete');
 console.log('[agent-assignment-cleanup] All Owned Fixture Files Retired Or Absent.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)await cleanupAgentAssignmentFixtures();
