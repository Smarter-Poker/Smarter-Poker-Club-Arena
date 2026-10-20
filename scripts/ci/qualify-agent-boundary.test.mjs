import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {supabaseServerHeaders} from './supabase-auth-headers.mjs';
const source=readFileSync(new URL('./qualify-agent-boundary.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function fixture(failure,email='ca-customization-cert-postdeploy-fixture@example.invalid') {
 const id='00000000-0000-4000-8000-000000000001';
 const state={role:'admin',agent:null,reads:0,results:null};
 const account={id,email,password:'reserved-fixture-only'};
 const fetch=async(url,init)=>{
  state.reads++;const u=new URL(url);const method=init.method;const body=init.body?JSON.parse(init.body):null;
  let data,status=200;
  if(u.pathname.startsWith('/api/club-arena/')) {status=403;data={error:'forbidden'};}
  else if(u.pathname==='/auth/v1/token') data={access_token:'fixture-session',user:{id}};
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
  } else if(u.pathname==='/rest/v1/player_stats') data=[];
  else if(u.pathname==='/rest/v1/clubs') {status=failure==='private-column'?200:403;data=[];}
  else if(u.pathname==='/rest/v1/rpc/fn_cashier_statement_scope') data={authorized:true,role:state.role,scope:'downline'};
  else if(u.pathname==='/rest/v1/rpc/ca_club_roster_rows') data=[{user_id:id}];
  else if(u.pathname==='/rest/v1/rpc/fn_reassign_club_members') {status=403;data={code:'42501'};}
  else if(u.pathname.startsWith('/rest/v1/rpc/')) data=false;
  else throw new Error('Unexpected fixture request '+u.pathname);
  if(u.pathname==='/rest/v1/club_members' && u.searchParams.has('agent_id')) data=[];
  if(u.pathname==='/rest/v1/agents' && u.searchParams.has('parent_agent_id')) data=[];
  return {status,ok:status<400,async text(){return status===204?'':JSON.stringify(data)}};
 };
 const run=new AsyncFunction('assert','readFileSync','randomUUID','join','supabaseServerHeaders','process','fetch','console',source);
 const pending=run(assert,()=>JSON.stringify(account),randomUUID,join,supabaseServerHeaders,{env:{RUNNER_TEMP:'/fixture',SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',VITE_SUPABASE_ANON_KEY:'sb_publishable_fixture'}},fetch,{log(text){state.results=JSON.parse(text)}});
 return {state,pending};
}
test('all three ranks are exercised and zero-balance fixture restores before completion',async()=>{
 const {state,pending}=await fixture();await pending;
 assert.deepEqual(state.results.results.map(r=>r.role),['super_agent','agent','sub_agent']);
 assert.equal(state.role,'admin');assert.equal(state.agent,null);
});
for(const failure of ['private-column','unknown-create']) test('cleanup reads durable state after '+failure,async()=>{
 const {state,pending}=await fixture(failure);await assert.rejects(pending);
 assert.equal(state.role,'admin');assert.equal(state.agent,null);
});
test('a personal account is refused before any request',async()=>{
 const {state,pending}=await fixture(null,'personal@example.invalid');await assert.rejects(pending);
 assert.equal(state.reads,0);
});
