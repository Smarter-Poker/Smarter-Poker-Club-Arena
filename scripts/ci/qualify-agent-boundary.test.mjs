import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {supabaseServerHeaders} from './supabase-auth-headers.mjs';
import {retryTransient} from './transient-retry.mjs';
const source=readFileSync(new URL('./qualify-agent-boundary.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function fixture(failure,email='ca-customization-cert-postdeploy-fixture@example.invalid') {
 const id='00000000-0000-4000-8000-000000000001';
 const state={role:'admin',agent:null,reads:0,results:null,exportCancelled:false};
 const account={id,email,password:'reserved-fixture-only'};
 const fetch=async(url,init)=>{
  state.reads++;const u=new URL(url);const method=init.method;const body=init.body?JSON.parse(init.body):null;
  let data,status=200;
  if(u.pathname.startsWith('/api/club-arena/')) {status=403;data={error:'forbidden'};}
  else if(u.pathname==='/auth/v1/token') {assert.equal(init.headers.apikey,'sb_publishable_fixture');assert.equal(init.headers.Authorization,undefined);data={access_token:'fixture-session',user:{id}};}
  else if(u.pathname==='/auth/v1/logout') {data=null;status=204;}
  else if(u.pathname==='/rest/v1/profiles') data=[{email,role:'user',is_admin:false,is_horse:false}];
  else if(u.pathname==='/rest/v1/club_members') {
   if(method==='PATCH') {assert.equal(u.searchParams.get('user_id'),'eq.'+id);state.role=body.role;}
   data=[{user_id:id,role:state.role,status:'active',agent_id:null,parent_agent_id:null,chip_balance:0,promo_balance:0,held_chips:0,locked_chips:0,credit_used:0,credit_limit:0}];
  } else if(u.pathname==='/rest/v1/agents') {
   if(method==='POST') {state.agent={parent_agent_id:null,credit_used:0,credit_limit:0,business_balance:0,player_balance:0,promo_balance:0,agent_wallet_balance:0,player_wallet_balance:0,promo_wallet_balance:0,total_players:0,active_player_count:0,sub_agent_count:0,weekly_rake_generated:0,lifetime_earnings:0,lifetime_rake_generated:0,...body};if(failure==='unknown-create') throw new Error('transport unknown');}
   if(method==='PATCH') Object.assign(state.agent,body);
   if(method==='DELETE') state.agent=null;
   data=state.agent?[state.agent]:[];
  } else if(u.pathname==='/rest/v1/player_stats' || u.pathname==='/rest/v1/audit_trail') data=[];
  else if(u.pathname==='/rest/v1/clubs') {status=failure==='private-column'?200:403;data=[];}
  else if(u.pathname==='/rest/v1/rpc/fn_ca_club_data_scope') data='downline';
  else if(u.pathname==='/rest/v1/rpc/ca_club_data_screen') data={scope:'downline',rows:failure==='data-leak'?[{id:'unrelated'}]:[],summary:{games:0,fee:0,total_winnings:0,mtt_winnings:0,on_felt:0}};
  else if(u.pathname==='/rest/v1/rpc/fn_agent_downline_rake' || u.pathname==='/rest/v1/rpc/fn_agent_downline_rake_summary') {
   if(body.p_club_id==='fade0000-0000-0000-0000-000000000001') {status=403;data={code:'42501'};}
   else if(u.pathname.endsWith('_summary')) data={members:0,hands:0,rake_generated:failure==='legacy-leak'?100:0,commission_rate:0,estimated_commission:0};
   else data=[];
  }
  else if(['ca_club_game_export_start','ca_club_player_export_start','ca_rake_export_start','ca_rake_export_start_v2'].some(name=>u.pathname==='/rest/v1/rpc/'+name)) {status=failure==='export-leak'?200:403;data=status===200?{export_id:id}:{code:'42501'};}
  else if(u.pathname==='/rest/v1/rpc/ca_club_data_export_cancel') {state.exportCancelled=true;data=true;}
  else if(['ca_club_data_snapshot_v2','ca_rake_snapshot_v2'].some(name=>u.pathname==='/rest/v1/rpc/'+name)) {status=403;data={code:'42501'};}
  else if(u.pathname==='/rest/v1/rpc/fn_club_viewer_cashier_scope') data='downline';
  else if(u.pathname==='/rest/v1/rpc/fn_club_viewer_bank_role') data=state.role;
  else if(u.pathname==='/rest/v1/rpc/fn_cashier_statement_scope') data={authorized:true,role:state.role,scope:'downline'};
  else if(u.pathname==='/rest/v1/rpc/ca_club_members_page') data={items:[{user_id:id}]};
  else if(['fn_reassign_club_members','fn_preview_club_assignment','fn_club_assignment_history','fn_apply_reviewed_club_assignment','ca_club_members_export','fn_club_bank_role','fn_club_cashier_scope','fn_club_cashier_can_transact','fn_club_is_in_downline','ca_club_roster_access','ca_club_roster_rows'].some(name=>u.pathname==='/rest/v1/rpc/'+name)) {status=403;data={code:'42501'};}
  else if(u.pathname.startsWith('/rest/v1/rpc/')) data=false;
  else throw new Error('Unexpected fixture request '+u.pathname);
  if(u.pathname==='/rest/v1/club_members' && u.searchParams.has('agent_id')) data=[];
  if(u.pathname==='/rest/v1/agents' && u.searchParams.has('parent_agent_id')) data=[];
  return {status,ok:status<400,async text(){return status===204?'':JSON.stringify(data)}};
 };
 const run=new AsyncFunction('assert','readFileSync','randomUUID','join','supabaseServerHeaders','retryTransient','process','fetch','console',source);
 const pending=run(assert,()=>JSON.stringify(account),randomUUID,join,supabaseServerHeaders,retryTransient,{env:{RUNNER_TEMP:'/fixture',SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_test_fixture',VITE_SUPABASE_ANON_KEY:'sb_publishable_fixture'}},fetch,{log(text){state.results=JSON.parse(text)}});
 return {state,pending};
}
test('all three ranks are exercised and zero-balance fixture restores before completion',async()=>{
 const {state,pending}=await fixture();await pending;
 assert.deepEqual(state.results.results.map(r=>r.role),['super_agent','agent','sub_agent']);
 assert.equal(state.role,'admin');assert.equal(state.agent,null);
});
for(const failure of ['private-column','unknown-create','data-leak','legacy-leak','export-leak']) test('cleanup reads durable state after '+failure,async()=>{
 const {state,pending}=await fixture(failure);await assert.rejects(pending);
 assert.equal(state.role,'admin');assert.equal(state.agent,null);
 if(failure==='export-leak') assert.equal(state.exportCancelled,true);
});
test('a personal account is refused before any request',async()=>{
 const {state,pending}=await fixture(null,'personal@example.invalid');await assert.rejects(pending);
 assert.equal(state.reads,0);
});
