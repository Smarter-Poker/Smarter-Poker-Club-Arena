import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {supabaseServerHeaders} from './supabase-auth-headers.mjs';
const source=readFileSync(new URL('./qualify-agent-assignment.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function fixture(failure) {
 const staff={id:randomUUID(),email:'ca-customization-cert-postdeploy-staff@example.invalid',password:'fixture'};
 const members=new Map(),agents=new Map(),receipts=new Map(),accounts=new Map([[staff.id,staff]]);
 const state={created:[],cleaned:[],result:null,sequence:0,channels:[],closed:0};
 const createClient=()=>({realtime:{async setAuth(){},disconnect(){}},channel(){const channel={callback:null,on(_kind,_filter,callback){channel.callback=callback;return channel;},subscribe(callback){callback('SUBSCRIBED');return channel;}};state.channels.push(channel);return channel;},async removeAllChannels(){state.closed++;}});
 function row(id,role='player') {return {user_id:id,role,status:'active',agent_id:null,chip_balance:0,promo_balance:0,held_chips:0,locked_chips:0,credit_used:0,credit_limit:0};}
 members.set(staff.id,row(staff.id,'admin'));
 const create=async()=>{const account={id:randomUUID(),email:'ca-customization-cert-postdeploy-'+randomUUID()+'@example.invalid',password:'fixture'};accounts.set(account.id,account);state.created.push(account.id);return account;};
 let preparing=0;
 const prepare=async()=>{const id=state.created[preparing++];members.set(id,row(id));};
 const cleanup=async({record})=>{assert.ok(state.created.includes(record.id));members.delete(record.id);accounts.delete(record.id);state.cleaned.push(record.id);};
 const fetch=async(url,init)=>{
  const u=new URL(url),body=init.body?JSON.parse(init.body):null,method=init.method;
  const user=(u.searchParams.get('user_id') || '').slice(3),id=(u.searchParams.get('id') || '').slice(3);
  let data,status=200;
  if(u.pathname==='/auth/v1/token') {assert.equal(init.headers.Authorization,undefined);const account=[...accounts.values()].find(a=>a.email===body.email);data={access_token:account.id,user:{id:account.id}};}
  else if(u.pathname==='/auth/v1/logout') {status=204;data=null;}
  else if(u.pathname==='/rest/v1/profiles') data=[{alias:'Fixture Player',username:'Fixture Player',email:staff.email,role:'user',is_admin:false,is_horse:false}];
  else if(u.pathname==='/rest/v1/club_members') {
   if(method==='PATCH') Object.assign(members.get(user),body);
   if(user) data=members.has(user)?[members.get(user)]:[];
   else if(u.searchParams.has('agent_id')) data=[...members.values()].filter(r=>r.agent_id===u.searchParams.get('agent_id').slice(3));
   else {const caller=init.headers.Authorization.slice(7);data=[...members.values()].filter(r=>r.user_id===caller || r.agent_id===caller);}
  } else if(u.pathname==='/rest/v1/union_clubs' || u.pathname==='/rest/v1/clubs') data=[{union_id:'fade0000-0000-0000-0000-000000000001'}];
  else if(u.pathname==='/rest/v1/unions') data=[{settings:{min_agent_commission:0.2,max_agent_commission:0.7}}];
  else if(u.pathname==='/rest/v1/agents') {
   if(method==='POST') {assert.equal(body.commission_rate,0.2,'an earning agent uses the union band minimum');agents.set(body.id,{parent_agent_id:null,credit_used:0,credit_limit:0,business_balance:0,player_balance:0,promo_balance:0,agent_wallet_balance:0,player_wallet_balance:0,promo_wallet_balance:0,weekly_rake_generated:0,lifetime_earnings:0,lifetime_rake_generated:0,...body});if(failure==='unknown-agent') throw new Error('unknown agent response');}
   if(method==='DELETE') agents.delete(id);
   data=u.searchParams.has('parent_agent_id')?[]:id?(agents.has(id)?[agents.get(id)]:[]):[];
  } else if(u.pathname==='/rest/v1/rpc/fn_preview_club_assignment') data={selected_count:1,affected_count:1,review_token:'a'.repeat(32)};
  else if(u.pathname==='/rest/v1/rpc/fn_club_assignment_history') data={rows:[{operation_id:body.p_search,review:{review_token:'a'.repeat(32)}}]};
  else if(u.pathname==='/rest/v1/rpc/ca_club_roster_rows') {const caller=init.headers.Authorization.slice(7);data=[...members.values()].filter(r=>r.user_id===caller || r.agent_id===caller).map(row=>({...row,alias:'Fixture Player'}));}
  else if(u.pathname==='/rest/v1/rpc/ca_club_members_page') {const caller=init.headers.Authorization.slice(7);data={items:[...members.values()].filter(r=>r.user_id===state.created[2] && (r.user_id===caller || r.agent_id===caller)).map(row=>({...row,alias:"Fixture Player"}))};}
  else if(u.pathname==='/rest/v1/rpc/ca_club_roster_access') data=members.get(body.p_target_user_id)?.agent_id===init.headers.Authorization.slice(7)?'agent':'none';
  else if(u.pathname==='/rest/v1/rpc/ca_club_member_detail') {const caller=init.headers.Authorization.slice(7);data=members.get(body.p_user_id)?.agent_id===caller?{identity:{user_id:body.p_user_id}}:null;}
  else if(u.pathname==='/rest/v1/rpc/ca_club_members_export') {status=403;data={code:'42501'};}
  else if(u.pathname==='/rest/v1/game_management_events') data=u.searchParams.has('sequence')?[{sequence:state.sequence,recipient_id:u.searchParams.get('recipient_id').slice(3),payload:{reason:'member_scope_changed'}}]:[{sequence:state.sequence}];
  else if(['/rest/v1/rpc/fn_reassign_club_members','/rest/v1/rpc/fn_apply_reviewed_club_assignment'].includes(u.pathname)) {
   if(failure==='transfer' && body.p_expected_agent_user_id) {status=409;data={code:'source_changed'};}
   else {const replayed=receipts.has(body.p_op_id);receipts.set(body.p_op_id,body);for(const target of body.p_member_user_ids) members.get(target).agent_id=body.p_agent_user_id;data={success:true,moved:1,replayed};if(body.p_expected_agent_user_id && !replayed){state.sequence++;if(failure!=='missing-realtime')for(const channel of state.channels)for(const recipient of [body.p_expected_agent_user_id,body.p_agent_user_id])channel.callback({payload:{club_id:body.p_club_id,user_id:recipient,reason:'member_scope_changed',domains:[]}});}}
  } else throw new Error(u.pathname);
  return {ok:status<400,status,async text(){return status===204?'':JSON.stringify(data)},async json(){return data}};
 };
 const club='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
 const startAssignmentBrowserProof=async({account,playerId})=>{assert.equal(members.get(playerId).agent_id,account.id);state.browserStarted=true;return {async saveFromPlayerRecord(_actor,_session,target,beforeWrite){const move={p_club_id:club,p_member_user_ids:[playerId],p_agent_user_id:target,p_op_id:randomUUID(),p_expected_agent_user_id:account.id,p_review_token:'a'.repeat(32)};await beforeWrite(move);const result=await fetch('https://fixture.invalid/rest/v1/rpc/fn_apply_reviewed_club_assignment',{method:'POST',body:JSON.stringify(move),headers:{}});assert.ok(result.ok);state.browserSaved=true;return move;},async verifyAfterTransfer(){assert.notEqual(members.get(playerId).agent_id,account.id);state.browserChanged=true;},async verifyDestination(destination){assert.equal(members.get(playerId).agent_id,destination.id);},async close(){state.browserClosed=true;}};};
 const run=new AsyncFunction('assert','readFileSync','writeFileSync','join','randomUUID','createProductionE2EAccount','prepareProductionE2EStaffMembership','cleanupProductionE2EAccount','supabaseServerHeaders','createClient','WebSocket','startAssignmentBrowserProof','process','fetch','console',source);
 const pending=run(assert,()=>JSON.stringify(staff),()=>{},join,randomUUID,create,prepare,cleanup,supabaseServerHeaders,createClient,undefined,startAssignmentBrowserProof,{cwd:()=>'/fixture',env:{RUNNER_TEMP:'/fixture',SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_test_fixture',VITE_SUPABASE_ANON_KEY:'sb_publishable_fixture'}},fetch,{log(s){state.result=JSON.parse(s)}});
 return {state,pending,members,agents};
}
test('assignment, transfer, replay and immediate scope change retire all three owned fixtures',async()=>{
 const {state,pending,members,agents}=await fixture();await pending;
 assert.equal(state.result.playerRecordSave,true);assert.equal(state.browserSaved,true);assert.equal(state.result.scopeChangedImmediately,true);assert.equal(state.result.realtimeTransferReceived,true);assert.equal(state.browserStarted,true);assert.equal(state.browserChanged,true);assert.equal(state.browserClosed,true);assert.equal(state.closed,2);assert.equal(state.cleaned.length,3);assert.equal(members.size,1);assert.equal(agents.size,0);
});
for(const failure of ['transfer','unknown-agent']) test('durable fixture cleanup after '+failure,async()=>{
 const {state,pending,members,agents}=await fixture(failure);await assert.rejects(pending);
 assert.equal(state.cleaned.length,state.created.length);assert.equal(members.size,1);assert.equal(agents.size,0);
});

test('missing transfer Realtime event refuses proof and still retires owned fixtures',async()=>{
 const {state,pending,members,agents}=await fixture('missing-realtime');await assert.rejects(pending,/Transferred scope event was not received/);
 assert.equal(state.cleaned.length,3);assert.equal(state.closed,2);assert.equal(members.size,1);assert.equal(agents.size,0);
});
