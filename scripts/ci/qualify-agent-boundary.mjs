/** Finite, zero-balance production proof using only this job's reserved account. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {supabaseServerHeaders} from './supabase-auth-headers.mjs';

const env=process.env;
const account=JSON.parse(readFileSync(env.E2E_TEST_ACCOUNT_FILE || join(env.RUNNER_TEMP,'club-arena-production-e2e-account.json'),'utf8'));
assert.match(account.email,/^ca-customization-cert-postdeploy-.+@example\.invalid$/);
assert.match(account.id,/^[a-f0-9-]{36}$/);
const base=env.SUPABASE_URL?.replace(/\/$/,'');
const service=env.SUPABASE_SERVICE_ROLE_KEY;
const anon=env.VITE_SUPABASE_ANON_KEY;
const club=env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
assert.equal(club,'a41434bb-8d0c-400a-8f0d-e8b3d65afed4','Only the existing certification club is permitted');
assert.ok(base && service && anon && account.password);
let token;
async function request(path,{method='GET',body,key=service,jwt=service,allowFailure=false}={}) {
 const common={'Content-Type':'application/json',Prefer:'return=representation'};
 const headers=jwt===service ? supabaseServerHeaders(service,common)
  : jwt===anon && key===anon ? {...common,apikey:key}
  : {...common,apikey:key,Authorization:`Bearer ${jwt}`};
 const r=await fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await r.text();const data=text?JSON.parse(text):null;
 if(!allowFailure && !r.ok) throw new Error(`Boundary qualification ${method} ${path.split('?')[0]} refused: HTTP ${r.status}, code ${data?.code || 'unknown'}`);
 return {data,status:r.status,ok:r.ok};
}
const membership=`/rest/v1/club_members?club_id=eq.${club}&user_id=eq.${account.id}`;
const agentId=randomUUID();
const agent=`/rest/v1/agents?id=eq.${agentId}&club_id=eq.${club}&user_id=eq.${account.id}`;
const balanceFields=['chip_balance','promo_balance','held_chips','locked_chips','credit_used','credit_limit'];
function zero(row,fields) { for(const f of fields) {assert.ok(Object.hasOwn(row,f),'Missing custody field '+f);assert.equal(Number(row[f]),0,f);} }
async function member() {const {data}=await request(membership+'&select=*');assert.equal(data.length,1);zero(data[0],balanceFields);return data[0];}
const start=await member();
assert.equal(start.role,'admin');assert.equal(start.status,'active');
assert.equal(start.agent_id,null);assert.equal(start.parent_agent_id,null);
const existing=await request(`/rest/v1/agents?club_id=eq.${club}&user_id=eq.${account.id}&select=id`);
assert.equal(existing.data.length,0);
const profile=await request(`/rest/v1/profiles?id=eq.${account.id}&select=email,role,is_admin,is_horse`);
assert.equal(profile.data.length,1);assert.equal(profile.data[0].email,account.email);
assert.equal(profile.data[0].role,'user');assert.ok(!profile.data[0].is_admin && !profile.data[0].is_horse);
const auth=await request('/auth/v1/token?grant_type=password',{method:'POST',key:anon,jwt:anon,body:{email:account.email,password:account.password}});
token=auth.data.access_token;assert.ok(token);assert.equal(auth.data.user.id,account.id);
const caller={key:anon,jwt:token};
async function rpc(name,args) {return (await request('/rest/v1/rpc/'+name,{...caller,method:'POST',body:args})).data;}
let mutationStarted=false;
const results=[];
try {
 mutationStarted=true;
 await request('/rest/v1/agents',{method:'POST',body:{id:agentId,user_id:account.id,club_id:club,role:'super_agent',status:'active',commission_rate:0,player_rakeback_rate:0}});
 for(const role of ['super_agent','agent','sub_agent']) {
  const current=await member();
  const changed=await request(membership+`&role=eq.${current.role}`,{method:'PATCH',body:{role}});
  assert.equal(changed.data.length,1);
  await request(agent,{method:'PATCH',body:{role}});
  assert.equal(await rpc('fn_can_use_club_bank',{p_club_id:club}),false);
  assert.equal(await rpc('ca_can_view_club_finances',{p_club_id:club}),false);
  assert.equal(await rpc('fn_can_manage_club_assignments',{p_club_id:club}),false);
  assert.equal(await rpc('is_club_admin',{p_club_id:club}),false);
  const audit=await request(`/rest/v1/audit_trail?club_id=eq.${club}&select=id`,caller);
  assert.equal(audit.data.length,0);
  const scope=await rpc('fn_cashier_statement_scope',{p_club_id:club});
  assert.equal(scope.authorized,true);assert.equal(scope.role,role);assert.equal(scope.scope,'downline');
  const rows=await request(`/rest/v1/club_members?club_id=eq.${club}&select=user_id`,caller);
  assert.equal(rows.data.length,1);assert.equal(rows.data[0].user_id,account.id);
  const stats=await request(`/rest/v1/player_stats?club_id=eq.${club}&select=user_id`,caller);
  assert.ok(stats.data.every(r=>r.user_id===account.id));
  const privateRead=await request(`/rest/v1/clubs?id=eq.${club}&select=chip_treasury`,{...caller,allowFailure:true});
  assert.equal(privateRead.ok,false);assert.equal(privateRead.status,403);
  const roster=await rpc('ca_club_roster_rows',{p_club_id:club});
  assert.ok(Array.isArray(roster));assert.ok(roster.some(r=>r.user_id===account.id));assert.ok(roster.every(r=>r.user_id===account.id));
  for(const route of ['player-sessions','club-analytics']) {
   const response=await fetch(`https://smarter.poker/api/club-arena/${route}?clubId=${club}`,{headers:{Authorization:`Bearer ${token}`}});
   assert.equal(response.status,403,route+' must refuse agent private club reports');
  }
  const transfer=await request('/rest/v1/rpc/fn_reassign_club_members',{...caller,method:'POST',allowFailure:true,body:{p_club_id:club,p_member_user_ids:[account.id],p_agent_user_id:account.id,p_op_id:randomUUID()}});
  assert.equal(transfer.ok,false);assert.equal(transfer.status,403);
  for(const [name,args] of [
   ['fn_preview_club_assignment',{p_club_id:club,p_member_user_ids:[account.id],p_agent_user_id:account.id}],
   ['fn_club_assignment_history',{p_club_id:club}],
   ['ca_club_members_export',{p_club_id:club,p_user_ids:[account.id]}],
   ['fn_apply_reviewed_club_assignment',{p_club_id:club,p_member_user_ids:[account.id],p_agent_user_id:account.id,p_op_id:randomUUID(),p_review_token:'a'.repeat(32)}],
  ]) {
   const denied=await request('/rest/v1/rpc/'+name,{...caller,method:'POST',allowFailure:true,body:args});
   assert.equal(denied.status,403,name+' must refuse agent access');
  }
  results.push({role,bankDenied:true,privateColumnsDenied:true,unrelatedMembers:0,assignmentDenied:true});
 }
} finally {
 if(mutationStarted) {
  // Read after any unknown response; restore only this job's exact reserved identity.
  const current=await member();
  if(current.role!=='admin') {
   assert.ok(['super_agent','agent','sub_agent'].includes(current.role));
   const restored=await request(membership+`&role=eq.${current.role}`,{method:'PATCH',body:{role:'admin'}});
   assert.equal(restored.data.length,1);
  }
  const owned=await request(agent+'&select=*');
  if(owned.data.length) {
   assert.equal(owned.data.length,1);
   const row=owned.data[0];assert.equal(row.parent_agent_id,null);
   zero(row,['credit_used','credit_limit','business_balance','player_balance','promo_balance','agent_wallet_balance','player_wallet_balance','promo_wallet_balance','total_players','active_player_count','sub_agent_count','weekly_rake_generated','lifetime_earnings','lifetime_rake_generated']);
   const children=await request(`/rest/v1/club_members?club_id=eq.${club}&agent_id=eq.${account.id}&select=user_id`);
   assert.equal(children.data.length,0);
   const agentChildren=await request(`/rest/v1/agents?club_id=eq.${club}&parent_agent_id=eq.${agentId}&select=id`);
   assert.equal(agentChildren.data.length,0);
   await request(agent,{method:'DELETE'});
  }
  assert.equal((await request(agent+'&select=id')).data.length,0);
  assert.equal((await member()).role,'admin');
 }
 if(token) await request('/auth/v1/logout?scope=local',{...caller,method:'POST',allowFailure:true}).catch(()=>{});
}
console.log(JSON.stringify({qualification:'agent-private-boundary',results,restoredAdmin:true,agentFixtureRemoved:true}));
