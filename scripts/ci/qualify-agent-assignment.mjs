/** Positive production assignment proof. Every target is a new reserved zero-chip identity. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProductionE2EAccount,prepareProductionE2EStaffMembership,cleanupProductionE2EAccount} from './production-e2e-account.mjs';
import {supabaseServerHeaders} from './supabase-auth-headers.mjs';
const env=process.env;
const root=env.RUNNER_TEMP;
assert.ok(root);
const staff=JSON.parse(readFileSync(env.E2E_TEST_ACCOUNT_FILE || join(root,'club-arena-production-e2e-account.json'),'utf8'));
assert.match(staff.email,/^ca-customization-cert-postdeploy-.+@example\.invalid$/);
const club='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
assert.ok(!env.E2E_CLUB_ID || env.E2E_CLUB_ID===club);
const base=env.SUPABASE_URL?.replace(/\/$/,'');
const service=env.SUPABASE_SERVICE_ROLE_KEY,anon=env.VITE_SUPABASE_ANON_KEY;
assert.ok(base && service && anon);
const owned=[],sessions=[];
async function req(path,{method='GET',body,token}={}) {
 const headers=token?{apikey:anon,Authorization:`Bearer ${token}`} :supabaseServerHeaders(service);
 const r=await fetch(base+path,{method,headers:{...headers,'Content-Type':'application/json',Prefer:'return=representation'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await r.text(),data=text?JSON.parse(text):null;
 assert.ok(r.ok,`Assignment proof ${method} ${path.split('?')[0]}: HTTP ${r.status}, ${data?.code || 'unknown'}`);
 return data;
}
async function login(account) {
 const r=await fetch(base+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},body:JSON.stringify({email:account.email,password:account.password})});
 const data=await r.json();assert.ok(r.ok && data.access_token);assert.equal(data.user.id,account.id);
 sessions.push(data.access_token);return data.access_token;
}
const member=(id)=>`/rest/v1/club_members?club_id=eq.${club}&user_id=eq.${id}`;
const zeroFields=['chip_balance','promo_balance','held_chips','locked_chips','credit_used','credit_limit'];
function zero(row,fields=zeroFields) { for(const key of fields) {assert.ok(Object.hasOwn(row,key));assert.equal(Number(row[key]),0,key);} }
async function membership(id) {const rows=await req(member(id)+'&select=*');assert.equal(rows.length,1);zero(rows[0]);return rows[0];}
const actor=await membership(staff.id);assert.equal(actor.role,'admin');assert.equal(actor.status,'active');
const actorProfile=await req(`/rest/v1/profiles?id=eq.${staff.id}&select=email,role,is_admin,is_horse`);
assert.equal(actorProfile.length,1);assert.equal(actorProfile[0].email,staff.email);assert.equal(actorProfile[0].role,'user');assert.ok(!actorProfile[0].is_admin && !actorProfile[0].is_horse);
let passed=false;
try {
 const token=await login(staff);
 for(let index=0;index<3;index++) {
  const childEnv={...env,E2E_TEST_ACCOUNT_FILE:join(root,`agent-assignment-${index}.json`),GITHUB_ENV:join(root,`agent-assignment-${index}.env`),E2E_CLUB_ID:club};
  const account=await createProductionE2EAccount({environment:childEnv});
  const item={account,environment:childEnv,agentId:index<2?randomUUID():null};owned.push(item);
  await prepareProductionE2EStaffMembership({environment:childEnv,memberRole:'player'});
  const current=await membership(account.id);assert.equal(current.agent_id,null);
  if(item.agentId) {
   await req(member(account.id),{method:'PATCH',body:{role:'agent'}});
   await req('/rest/v1/agents',{method:'POST',body:{id:item.agentId,user_id:account.id,club_id:club,role:'agent',status:'active',commission_rate:0,player_rakeback_rate:0}});
  }
 }
 const [source,destination,player]=owned;
 const first={p_club_id:club,p_member_user_ids:[player.account.id],p_agent_user_id:source.account.id,p_op_id:randomUUID()};
 const move={...first,p_agent_user_id:destination.account.id,p_op_id:randomUUID(),p_expected_agent_user_id:source.account.id};
 // Durable operation identities before writes; unknown outcomes are never replayed with new IDs.
 writeFileSync(join(root,'agent-assignment-operations.json'),JSON.stringify({first,move}),{mode:0o600});
 const assign=await req('/rest/v1/rpc/fn_reassign_club_members',{method:'POST',token,body:first});assert.equal(assign.success,true);assert.equal(assign.moved,1);
 assert.equal((await membership(player.account.id)).agent_id,source.account.id);
 const sourceToken=await login(source.account);
 const visible=()=>req(`/rest/v1/club_members?club_id=eq.${club}&select=user_id`,{token:sourceToken});
 assert.deepEqual((await visible()).map(r=>r.user_id).sort(),[source.account.id,player.account.id].sort());
 const transfer=await req('/rest/v1/rpc/fn_reassign_club_members',{method:'POST',token,body:move});assert.equal(transfer.success,true);assert.equal(transfer.moved,1);
 assert.equal((await membership(player.account.id)).agent_id,destination.account.id);
 assert.deepEqual((await visible()).map(r=>r.user_id),[source.account.id]);
 const replay=await req('/rest/v1/rpc/fn_reassign_club_members',{method:'POST',token,body:move});assert.equal(replay.replayed,true);
 const destinationToken=await login(destination.account);
 assert.deepEqual((await req(`/rest/v1/club_members?club_id=eq.${club}&select=user_id`,{token:destinationToken})).map(r=>r.user_id).sort(),[destination.account.id,player.account.id].sort());
 passed=true;
} finally {
 const errors=[];
 // The player is removed first; agent deletion is refused if any child or custody remains.
 for(const item of [...owned].reverse()) {
  try {
   const rows=await req(member(item.account.id)+'&select=*');if(rows.length) {assert.equal(rows.length,1);zero(rows[0]);}
   if(item.agentId) {
    assert.equal((await req(`/rest/v1/club_members?club_id=eq.${club}&agent_id=eq.${item.account.id}&select=user_id`)).length,0);
    assert.equal((await req(`/rest/v1/agents?club_id=eq.${club}&parent_agent_id=eq.${item.agentId}&select=id`)).length,0);
    const path=`/rest/v1/agents?id=eq.${item.agentId}&club_id=eq.${club}&user_id=eq.${item.account.id}`;
    const agents=await req(path+'&select=*');assert.ok(agents.length<=1);
    if(agents.length) {
     assert.equal(agents[0].parent_agent_id,null);
     zero(agents[0],['credit_used','credit_limit','business_balance','player_balance','promo_balance','agent_wallet_balance','player_wallet_balance','promo_wallet_balance','weekly_rake_generated','lifetime_earnings','lifetime_rake_generated']);
     await req(path,{method:'DELETE'});assert.equal((await req(path+'&select=id')).length,0);
    }
   }
   await cleanupProductionE2EAccount({environment:item.environment,record:item.account});
  } catch(error) {errors.push(error);}
 }
 for(const token of sessions) await fetch(base+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:anon,Authorization:`Bearer ${token}`}}).catch(()=>{});
 if(errors.length) throw new AggregateError(errors,'Assignment fixture cleanup incomplete');
}
assert.equal(passed,true);
console.log(JSON.stringify({qualification:'agent-assignment-transfer',assignment:true,transfer:true,replay:true,scopeChangedImmediately:true,isolatedAccountsRemoved:owned.length}));
