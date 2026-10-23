/** Positive production assignment proof. Every target is a new reserved zero-chip identity. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProductionE2EAccount,prepareProductionE2EStaffMembership,cleanupProductionE2EAccount} from './production-e2e-account.mjs';
import {createClient} from '@supabase/supabase-js';
import WebSocket from 'ws';
import {supabaseServerHeaders} from './supabase-auth-headers.mjs';
import {startAssignmentBrowserProof} from './qualify-agent-assignment-browser.mjs';
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
const owned=[],sessions=[],realtimeClients=[],loginSessions=new Map();
let browserProof;
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
 sessions.push(data.access_token);loginSessions.set(account.id,data);return data.access_token;
}
async function listenForTransfer(viewer,token,baseline) {
 const client=createClient(base,anon,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},realtime:{transport:WebSocket}});
 realtimeClients.push(client);await client.realtime.setAuth(token);
 const observed=[];let notify;
 const matches=()=>observed.some(row=>row.user_id===viewer && row.club_id===club && row.reason==='member_scope_changed');
 const channel=client.channel('profile-account:'+viewer,{config:{private:true}}).on('broadcast',{event:'account_changed'},event=>{observed.push(event.payload);if(notify)notify();});
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Recipient scope subscription timed out')),15000);
  channel.subscribe(status=>{
   if(status==='SUBSCRIBED'){clearTimeout(timer);resolve();}
   else if(['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status)){clearTimeout(timer);reject(new Error('Recipient scope subscription refused: '+status));}
  });
 });
 return async()=>{
  if(matches())return;
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{notify=null;reject(new Error('Transferred scope event was not received over Realtime'));},20000);
   notify=()=>{if(matches()){clearTimeout(timer);notify=null;resolve();}};
   notify();
  });
 };
}
const member=(id)=>`/rest/v1/club_members?club_id=eq.${club}&user_id=eq.${id}`;
const zeroFields=['chip_balance','promo_balance','held_chips','locked_chips','credit_used','credit_limit'];
function zero(row,fields=zeroFields) { for(const key of fields) {assert.ok(Object.hasOwn(row,key));assert.equal(Number(row[key]),0,key);} }
async function membership(id) {const rows=await req(member(id)+'&select=*');assert.equal(rows.length,1);zero(rows[0]);return rows[0];}
const actor=await membership(staff.id);assert.equal(actor.role,'admin');assert.equal(actor.status,'active');
const actorProfile=await req(`/rest/v1/profiles?id=eq.${staff.id}&select=email,role,is_admin,is_horse`);
assert.equal(actorProfile.length,1);assert.equal(actorProfile[0].email,staff.email);assert.equal(actorProfile[0].role,'user');assert.ok(!actorProfile[0].is_admin && !actorProfile[0].is_horse);
// The certification club sits in a union whose policy band bounds an earning
// agent's commission (fn_enforce_agent_commission_bounds). These identities
// never play, so the rate is inert; use the band's own minimum, never 0.
async function earningAgentCommission() {
 const links=await req(`/rest/v1/union_clubs?club_id=eq.${club}&select=union_id`);
 const clubRows=await req(`/rest/v1/clubs?id=eq.${club}&select=union_id`);
 const unionId=links[0]?.union_id || clubRows[0]?.union_id || null;
 if(!unionId) return 0;
 const unions=await req(`/rest/v1/unions?id=eq.${unionId}&select=settings`);
 const min=Number(unions[0]?.settings?.min_agent_commission ?? 0);
 assert.ok(Number.isFinite(min) && min>=0 && min<=1,'Unreadable union agent commission band');
 return min;
}
let passed=false;
try {
 const token=await login(staff);
 const commissionRate=await earningAgentCommission();
 for(let index=0;index<3;index++) {
  const childEnv={...env,E2E_TEST_ACCOUNT_FILE:join(root,`agent-assignment-${index}.json`),GITHUB_ENV:join(root,`agent-assignment-${index}.env`),E2E_CLUB_ID:club};
  const account=await createProductionE2EAccount({environment:childEnv});
  const item={account,environment:childEnv,agentId:index<2?randomUUID():null};owned.push(item);
  await prepareProductionE2EStaffMembership({environment:childEnv,memberRole:'player'});
  const current=await membership(account.id);assert.equal(current.agent_id,null);
  if(item.agentId) {
   await req(member(account.id),{method:'PATCH',body:{role:'agent'}});
   await req('/rest/v1/agents',{method:'POST',body:{id:item.agentId,user_id:account.id,club_id:club,role:'agent',status:'active',commission_rate:commissionRate,player_rakeback_rate:0}});
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
 const destinationToken=await login(destination.account);
 const baselineRows=await req(`/rest/v1/game_management_events?recipient_id=in.(${source.account.id},${destination.account.id})&club_id=eq.${club}&select=sequence&order=sequence.desc&limit=1`);
 const baseline=baselineRows.length?Number(baselineRows[0].sequence):0;assert.ok(Number.isSafeInteger(baseline));
 const sourceEvent=await listenForTransfer(source.account.id,sourceToken,baseline);
 const destinationEvent=await listenForTransfer(destination.account.id,destinationToken,baseline);
 const playerProfile=await req(`/rest/v1/profiles?id=eq.${player.account.id}&select=alias,username`);
 const playerSearch=playerProfile[0].alias || playerProfile[0].username;assert.ok(playerSearch);
 const sourceRoster=await req('/rest/v1/rpc/ca_club_members_page',{method:'POST',token:sourceToken,body:{p_club_id:club,p_search:playerSearch,p_limit:80}});
 const browserPlayer=sourceRoster.items.find(row=>row.user_id===player.account.id);assert.ok(browserPlayer?.alias);
 browserProof=await startAssignmentBrowserProof({account:source.account,session:loginSessions.get(source.account.id),clubId:club,playerId:player.account.id,playerAlias:browserPlayer.alias,evidenceDir:join(process.cwd(),'e2e-report','agent-assignment')});
 const applied=await browserProof.saveFromPlayerRecord(staff,loginSessions.get(staff.id),destination.account.id,body=>{
  assert.equal(body.p_expected_agent_user_id,source.account.id);
  Object.assign(move,body);
  writeFileSync(join(root,'agent-assignment-operations.json'),JSON.stringify({first,move}),{mode:0o600});
 });
 assert.deepEqual(applied,move);
 assert.equal((await membership(player.account.id)).agent_id,destination.account.id);
 await Promise.all([sourceEvent(),destinationEvent()]);
 await browserProof.verifyAfterTransfer();
 await browserProof.verifyDestination(destination.account,loginSessions.get(destination.account.id));
 assert.deepEqual((await visible()).map(r=>r.user_id),[source.account.id]);
 const replay=await req('/rest/v1/rpc/fn_apply_reviewed_club_assignment',{method:'POST',token,body:move});assert.equal(replay.replayed,true);
 assert.deepEqual((await req(`/rest/v1/club_members?club_id=eq.${club}&select=user_id`,{token:destinationToken})).map(r=>r.user_id).sort(),[destination.account.id,player.account.id].sort());
 const history=await req('/rest/v1/rpc/fn_club_assignment_history',{method:'POST',token,body:{p_club_id:club,p_search:move.p_op_id,p_limit:25}});
 assert.equal(history.rows.length,1);assert.equal(history.rows[0].operation_id,move.p_op_id);assert.equal(history.rows[0].review.review_token,move.p_review_token);
 for(const [viewer,viewerToken,expected] of [[source.account.id,sourceToken,false],[destination.account.id,destinationToken,true]]) {
  const page=await req('/rest/v1/rpc/ca_club_members_page',{method:'POST',token:viewerToken,body:{p_club_id:club,p_search:playerSearch,p_limit:80}});
  assert.ok(Array.isArray(page.items));assert.equal(page.items.some(row=>row.user_id===player.account.id),expected);
  const detail=await req('/rest/v1/rpc/ca_club_member_detail',{method:'POST',token:viewerToken,body:{p_club_id:club,p_user_id:player.account.id,p_from:null,p_to:null}});
  if(expected)assert.equal(detail?.identity?.user_id,player.account.id);else assert.equal(detail,null);
  const exportResponse=await fetch(base+'/rest/v1/rpc/ca_club_members_export',{method:'POST',headers:{apikey:anon,Authorization:`Bearer ${viewerToken}`,'Content-Type':'application/json'},body:JSON.stringify({p_club_id:club,p_user_ids:[player.account.id]})});
  assert.equal(exportResponse.status,403,'Agent export requires staff authority');
  const events=await req(`/rest/v1/game_management_events?recipient_id=eq.${viewer}&club_id=eq.${club}&select=recipient_id,payload,sequence&sequence=gt.${baseline}&order=sequence.desc&limit=20`,{token:viewerToken});
  assert.ok(events.some(row=>Number(row.sequence)>baseline && row.recipient_id===viewer && row.payload?.reason==='member_scope_changed'));
 }
 passed=true;
} finally {
 const errors=[];
 if(browserProof){try{await browserProof.close();}catch(error){errors.push(error);}}
 for(const client of realtimeClients){try{await client.removeAllChannels();client.realtime.disconnect();}catch(error){errors.push(error);}}
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
console.log(JSON.stringify({qualification:'agent-assignment-transfer',assignment:true,playerRecordSave:true,reviewedTransfer:true,searchableHistory:true,recipientScopeEvents:true,realtimeTransferReceived:true,openBrowserScopeChangedWithoutReload:true,directBrowserBankDenied:true,destinationPlayerVisible:true,directMemberScope:true,rosterSearchScope:true,agentExportDenied:true,transfer:true,replay:true,scopeChangedImmediately:true,isolatedAccountsRetired:owned.length}));
