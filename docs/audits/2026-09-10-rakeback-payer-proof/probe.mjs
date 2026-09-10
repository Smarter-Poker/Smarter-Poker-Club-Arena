#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const uid = n => '00000000-0000-4000-8000-' + String(n).padStart(12,'0');
const outcomes=[];
const mode=process.argv[2]||'before';
const baseline=mode==='before'||mode==='guards';
async function client(name, role='service_role') {
 assert.match(process.env.PGHOST||'',/^\/tmp\/ca-rakeback-payer\.[A-Za-z0-9]+$/);
 const c = new Client({host:process.env.PGHOST,port:55473,user:'postgres',database:'payer_test',application_name:name}); await c.connect();
 if(role) await c.query("SET ROLE "+role);
 await c.query("SELECT set_config('request.jwt.claim.role',$1,false)",[role||'service_role']);
 return c;
}
const db=await client('payer_admin',null);
async function query(sql,params=[]) {return (await db.query(sql,params)).rows;}
async function reset({assigned=true,agent=25,treasury=20,period=501}={}) {
 if(mode==='guards')await query('TRUNCATE chip_ledger_idem');
 await query("TRUNCATE rakeback_period_payouts,rakeback_periods,club_members,agents,clubs,union_clubs,rakeback_daily_user,rakeback_daily_state,chip_ledger,wallet_transactions,chip_transactions,wallet_credit_idempotency,ca_ledger_mutation_log,settlement_locks");
 await query("INSERT INTO clubs(id,name,owner_id,chip_treasury) VALUES($1,'Synthetic payer club',$2,$3)",[uid(900),uid(990),treasury]);
 await query("INSERT INTO union_clubs(union_id,club_id) VALUES($1,$2)",[uid(999),uid(900)]);
 await query("INSERT INTO club_members(club_id,user_id,role,chip_balance,agent_id,player_rakeback_pct) VALUES($1,$2,'player',0,$3,.15),($1,$4,'agent',$5,NULL,0)",[uid(900),uid(201),assigned?uid(101):null,uid(101),agent]);
 await query("INSERT INTO agents(id,user_id,club_id,role,commission_rate,player_rakeback_rate) VALUES($1,$2,$3,'agent',.25,.15)",[uid(1),uid(101),uid(900)]);
 await query("INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,rakeback_earned) VALUES($1,$2,$3,'2026-08-31','2026-09-06',100,.15,15,15)",[uid(period),uid(201),uid(900)]);
 await query("INSERT INTO rakeback_daily_state(club_id,day,rows_seen) SELECT $1,d::date,1 FROM generate_series('2026-08-31'::date,'2026-09-06'::date,'1 day')d",[uid(900)]);
 await query("INSERT INTO rakeback_daily_user(club_id,day,user_id,cents) VALUES($1,'2026-08-31',$2,10000)",[uid(900),uid(201)]);
}
const closeSql="SELECT public.fn_close_settlement_period('"+uid(501)+"') result";
const claimSql="SELECT public.fn_claim_rakeback('"+uid(900)+"') result";
const weeklySql="SELECT public.fn_settle_round3_agents_to_players('"+uid(999)+"','2026-08-31T07:00:00Z','2026-09-07T07:00:00Z') result";
async function snapshot(){
 return (await query("SELECT (SELECT chip_treasury::text FROM clubs WHERE id=$1) treasury,(SELECT chip_balance::text FROM club_members WHERE user_id=$2) agent,(SELECT chip_balance::text FROM club_members WHERE user_id=$3) player,(SELECT count(*)::int FROM rakeback_period_payouts) receipts,(SELECT count(*)::int FROM rakeback_period_payouts p JOIN wallet_transactions w ON w.id=p.wallet_transaction_id AND w.related_entity_id=p.id AND w.user_id=p.user_id AND w.amount=p.payout_amount) linked_receipts,(SELECT count(*)::int FROM chip_ledger WHERE category='rakeback') legs,(SELECT count(*)::int FROM wallet_transactions WHERE category='rakeback') wallet_rows",[uid(900),uid(101),uid(201)]))[0];
}
async function observeWait(c,app){
 for(let i=0;i<200;i++){
  const rows=await c.query("SELECT wait_event_type,wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE application_name=$1",[app]);
  if(rows.rows[0]?.wait_event_type==='Lock' && rows.rows[0].blockers.length){return rows.rows[0];}
  await new Promise(r=>setTimeout(r,10));
 } throw new Error("No observed lock wait for "+app);
}
async function race(firstSql,secondSql,label){
 await reset({agent:100});
 const blocker=await client(label+'_blocker',null);
 const a=await client(label+'_a'),b=await client(label+'_b',secondSql===claimSql?'authenticated':'service_role');
 if(secondSql===claimSql)await b.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid(201)]);
 await blocker.query("BEGIN");
 await blocker.query("SELECT 1 FROM club_members WHERE user_id=$1 FOR UPDATE",[uid(101)]);
 const first=a.query(firstSql).then(value=>({value:value.rows}),error=>({error:{code:error.code,message:error.message}}));
 const waitA=await observeWait(db,label+'_a');
 const second=b.query(secondSql).then(value=>({value:value.rows}),error=>({error:{code:error.code,message:error.message}}));
 let waitB;
 if(baseline && secondSql===claimSql){
  await second; waitB={completed_while_weekly_waited:true};
 }else waitB=await observeWait(db,label+'_b');
 await blocker.query("COMMIT");
 const callResults=await Promise.all([first,second]);
 const state=await snapshot();
 await Promise.all([a.end(),b.end(),blocker.end()]);
 return {state,waitA,waitB,callResults};
}
async function test(name,fn){await fn();outcomes.push({name,pass:true});console.log("PASS "+name);}
try {
 await test('individual close payer and actual wallet pointer',async()=>{
  await reset(); await query(closeSql); const s=await snapshot();
  if(baseline){assert.equal(s.agent,'25.00');assert.equal(s.treasury,'5.00');assert.equal(s.player,'15.00');assert.equal(s.linked_receipts,0);}
  else {assert.equal(s.agent,'10.00');assert.equal(s.treasury,'20.00');assert.equal(s.player,'15.00');assert.equal(s.linked_receipts,1);assert.equal(s.legs,1);}
  outcomes.push({evidence:'individual_claim',...s});
 });
 await test('observed simultaneous weekly selections',async()=>{
  const evidence=await race(weeklySql,weeklySql,'weekly_dupe');
  assert.equal(evidence.state.player,mode==='guards'?'15.00':(baseline?'30.00':'15.00'));
  assert.equal(evidence.state.receipts,baseline?0:1);
  if(mode==='guards')assert.equal(evidence.callResults[1].error?.code,'23505');
  outcomes.push({evidence:'weekly_dupe',...evidence});
 });
 await test('observed weekly wait versus independent claim',async()=>{
  const evidence=await race(weeklySql,claimSql,'weekly_claim');
  assert.equal(evidence.state.player,baseline?'30.00':'15.00');
  if(!baseline)assert.equal(evidence.state.linked_receipts,1);
  outcomes.push({evidence:'weekly_claim',...evidence});
 });
 writeFileSync(new URL(mode+'-proof.json',import.meta.url),JSON.stringify({mode,captured_at:new Date().toISOString(),outcomes},null,2)+'\n');
 console.log(JSON.stringify({mode,passed:outcomes.filter(x=>x.pass).length}));
} finally {await db.end();}
