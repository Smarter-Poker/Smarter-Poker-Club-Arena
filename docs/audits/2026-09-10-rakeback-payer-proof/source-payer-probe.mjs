import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
const {Client}=createRequire(import.meta.url)('pg');
const socket=process.env.PGHOST;assert.match(socket||'',/^\/tmp\/ca-rakeback-payer\.[A-Za-z0-9]+$/);
const config={host:socket,port:55473,user:'postgres',database:'payer_test'};
async function connect(name,role='service_role'){
 const c=new Client({...config,application_name:name});await c.connect();
 assert.equal((await c.query("SELECT inet_server_addr() IS NULL AND current_database()='payer_test' local_only")).rows[0].local_only,true);
 if(role)await c.query('SET ROLE '+role);
 await c.query("SELECT set_config('request.jwt.claim.role',$1,false)",[role||'service_role']);return c;
}
const db=await connect('source_payer_fixture',null);
const q=async(sql,args=[]) =>(await db.query(sql,args)).rows;
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
let serial=1000,hand=100000;
const results=[];
await q("INSERT INTO ca_cash_commission_authority VALUES(true,1,'2026-08-31','fixture-before','fixture-after')");
async function setup({balance=100,status='pending'}={}){
 const n=serial;serial+=1000;
 const x={club:id(n),user:id(n+1),payer:id(n+2),second:id(n+3),period:id(n+4)};
 await q("INSERT INTO clubs(id,name,owner_id,chip_treasury) VALUES($1,'Synthetic source payer', $2,1000)",[x.club,id(n+5)]);
 await q("INSERT INTO club_members(club_id,user_id,chip_balance,role,agent_id) VALUES($1,$2,0,'player',$3),($1,$3,$5,'agent',NULL),($1,$4,$5,'agent',NULL)",[x.club,x.user,x.payer,x.second,balance]);
 await q("INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,status,rakeback_earned,rakeback_amount) VALUES($1,$2,$3,'2026-08-31','2026-09-06',$4,999,999)",[x.period,x.user,x.club,status]);
 return x;
}
async function source(x,{payer=x.payer,rake='100',rate='.15',direct='.25',state='assigned',errors=[],terms=[],accepted='2026-09-02',settled='2026-09-02'}={}){
 const h=id(hand++);
 await q("INSERT INTO ca_cash_commission_sources(hand_id,table_id,hand_number,requested_club_id,accepted_payload_hash,rake_total,rake_method,contributions,returned_uncalled,contributor_count,accepted_at,settled_at) VALUES($1,$2,1,$2,md5($1::uuid::text),$3,'WEIGHTED_CONTRIBUTED','{}','{}',1,$4,$5)",[h,x.club,rake,accepted,settled]);
 await q("INSERT INTO ca_cash_commission_facts(hand_id,player_id,booked_club_id,payer_user_id,assignment_state,rake_credit,direct_commission_rate,player_rebate_rate,player_rebate_entitlement,player_terms,hierarchy,errors) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6::numeric*$8::numeric,jsonb_build_object('errors',$9::jsonb),'[]',$10::jsonb)",[h,x.user,x.club,payer,state,rake,direct,rate,JSON.stringify(terms),JSON.stringify(errors)]);
 return h;
}
async function pay(x,c=db){return (await c.query('SELECT fn_pay_captured_rakeback_period($1) result',[x.period])).rows[0].result;}
async function snapshot(x){
 return (await q("SELECT (SELECT chip_treasury::text FROM clubs WHERE id=$1) treasury,(SELECT chip_balance::text FROM club_members WHERE club_id=$1 AND user_id=$2) player,(SELECT chip_balance::text FROM club_members WHERE club_id=$1 AND user_id=$3) payer,(SELECT chip_balance::text FROM club_members WHERE club_id=$1 AND user_id=$4) other_payer,(SELECT count(*)::int FROM ca_rakeback_source_payments WHERE club_id=$1) payments,(SELECT count(*)::int FROM ca_rakeback_source_accruals WHERE club_id=$1) accruals,(SELECT status FROM rakeback_periods WHERE id=$5) period_status",[x.club,x.user,x.payer,x.second,x.period]))[0];
}
async function test(name,fn){await fn();results.push({name,pass:true});console.log('PASS '+name);}
async function observedWait(name){
 for(let i=0;i<200;i++){
  const r=(await q("SELECT wait_event_type,wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE application_name=$1",[name]))[0];
  if(r?.wait_event_type==='Lock'&&r.blockers.length)return r;
  await new Promise(r=>setTimeout(r,10));
 }throw Error('No observed wait '+name);
}
try{
 await test('mixed captured payers survive current assignment change and preserve treasury',async()=>{
  const x=await setup();await source(x);await source(x,{payer:x.second,rate:'.20',direct:'.35'});
  await q('UPDATE club_members SET agent_id=NULL WHERE club_id=$1 AND user_id=$2',[x.club,x.user]);
  const r=await pay(x),s=await snapshot(x);
  assert.equal(r.new_payout,35);assert.equal(s.player,'35.00');assert.equal(s.payer,'85.00');assert.equal(s.other_payer,'80.00');assert.equal(s.treasury,'1000.00');assert.equal(s.payments,2);
  const replay=await pay(x);assert.equal(replay.new_payout,0);assert.deepEqual(replay.paid_receipts,r.paid_receipts);
  assert.equal(r.source_final,false);
  for(const p of r.paid_receipts){
   const rows=await q('SELECT 1 FROM wallet_transactions w JOIN chip_ledger l ON l.id=$2 WHERE w.id=$1 AND w.related_entity_id=$3 AND w.amount=$4 AND l.amount=w.amount AND l.metadata->>\'wallet_transaction_id\'=w.id::text',[p.wallet_transaction_id,p.ledger_id,p.id,p.amount]);assert.equal(rows.length,1);
  }
 });
 await test('fractional source zero stays provisional and later fractions pay aggregate cents',async()=>{
  const x=await setup();await source(x,{rake:'.01'});let r=await pay(x);assert.equal(r.new_payout,0);assert.equal(r.source_final,false);
  for(let i=0;i<99;i++)await source(x,{rake:'.01'});
  r=await pay(x);assert.equal(r.new_payout,.15);assert.equal((await snapshot(x)).player,'0.15');
  for(let i=0;i<4;i++)await source(x,{rake:'.01'});
  r=await pay(x);assert.equal(r.new_payout,.01);assert.equal((await snapshot(x)).player,'0.16');
  assert.equal(r.paid_receipts.at(-1).cumulative_entitlement,.156);
 });
 await test('short original payer never falls back to funded club and exact retry pays once',async()=>{
  const x=await setup({balance:10});await source(x);let r=await pay(x);
  assert.equal(r.new_payout,0);assert.equal(r.deferred.length,1);assert.equal((await snapshot(x)).treasury,'1000.00');
  await q('UPDATE club_members SET chip_balance=20 WHERE club_id=$1 AND user_id=$2',[x.club,x.payer]);
  r=await pay(x);assert.equal(r.new_payout,15);assert.equal((await pay(x)).new_payout,0);
 });
 await test('invalid assigned source and unbound legacy policy never become zero paid',async()=>{
  const x=await setup();
  await source(x,{state:'assigned_invalid',errors:['inactive_agent']});
  await source(x,{payer:null,state:'unassigned',rate:null,direct:null,terms:['unassigned_rebate_policy_unbound']});
  await source(x,{direct:'0'});await source(x,{direct:null});
  const r=await pay(x);assert.equal(r.new_payout,0);assert.equal(r.deferred.length,4);assert.equal((await snapshot(x)).accruals,0);
 });
 await test('pre-contract legacy sources and pending estimates cannot initiate backpay',async()=>{
  const x=await setup();await source(x,{accepted:'2026-08-30'});const before=await snapshot(x),r=await pay(x);
  assert.equal(r.new_payout,0);assert.equal(r.source_accruals_added,0);assert.deepEqual(await snapshot(x),before);
 });
 await test('overlapping noncanonical period cannot pay a source twice',async()=>{
  const x=await setup();await source(x);await pay(x);
  const other={...x,period:id(serial++)};
  await q("INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end) VALUES($1,$2,$3,'2026-09-01','2026-09-07')",[other.period,x.user,x.club]);
  await assert.rejects(pay(other),e=>e.code==='23514'&&/canonical earning week/.test(e.message));assert.equal((await snapshot(x)).player,'15.00');
 });
 await test('paid legacy period fields are not rewritten by prospective source receipts',async()=>{
  const x=await setup({status:'paid'});await source(x);await pay(x);assert.equal((await snapshot(x)).period_status,'paid');
 });
 await test('final journal error rolls back wallets source accrual and receipt together',async()=>{
  const x=await setup();await source(x);const before=await snapshot(x);
  await q("SELECT set_config('test.fail_journal','1',false)");
  try{await assert.rejects(pay(x),/injected final journal failure/);}finally{await q("SELECT set_config('test.fail_journal','',false)");}
  assert.deepEqual(await snapshot(x),before);
 });
 await test('observed concurrent source payment shares advisory lock and pays once',async()=>{
  const x=await setup();await source(x);
  const blocker=await connect('source_block',null),a=await connect('source_first'),b=await connect('source_second');
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 FOR UPDATE',[x.club,x.payer]);
   const first=pay(x,a);const waitA=await observedWait('source_first');
   const second=pay(x,b);const waitB=await observedWait('source_second');
   assert.equal(waitB.wait_event,'advisory');await blocker.query('COMMIT');
   const [ra,rb]=await Promise.all([first,second]);assert.equal(ra.new_payout+rb.new_payout,15);assert.equal((await snapshot(x)).payments,1);
   results.push({evidence:'observed_source_overlap',waitA,waitB});
  }finally{await Promise.all([blocker.end(),a.end(),b.end()]);}
 });
 await test('new immutable accrual and payment reject owner updates deletes and truncation',async()=>{
  for(const table of ['ca_rakeback_source_accruals','ca_rakeback_source_payments']){
   for(const sql of ['UPDATE '+table+' SET created_at=created_at','DELETE FROM '+table,'TRUNCATE '+table])
    await assert.rejects(q(sql),e=>e.code==='55000');
  }
 });
 await test('paid receipt protects wallet identity and ledger metadata from later mutation',async()=>{
  const p=(await q('SELECT * FROM ca_rakeback_source_payments LIMIT 1'))[0];
  await assert.rejects(q("UPDATE wallet_transactions SET related_entity_id=NULL WHERE id=$1",[p.wallet_transaction_id]),e=>e.code==='55000');
  await assert.rejects(q("UPDATE wallet_transactions SET user_id=$2 WHERE id=$1",[p.wallet_transaction_id,id(999999)]),e=>e.code==='55000');
  await assert.rejects(q("UPDATE chip_ledger SET metadata='{}' WHERE id=$1",[p.ledger_id]),e=>e.code==='55000');
 });
 await test('API roles cannot mutate source evidence or directly invoke internal payer',async()=>{
  for(const role of ['anon','authenticated']){
   const c=await connect('source_acl_'+role,role);
   try{await assert.rejects(c.query('SELECT fn_pay_captured_rakeback_period($1)',[id(1004)]),e=>e.code==='42501');}finally{await c.end();}
  }
  const c=await connect('source_receipt_acl');
  try{for(const table of ['ca_rakeback_source_accruals','ca_rakeback_source_payments']){
   await assert.rejects(c.query('DELETE FROM '+table),e=>e.code==='42501');
   await assert.rejects(c.query('TRUNCATE '+table),e=>e.code==='42501');
  }}finally{await c.end();}
 });
 writeFileSync(new URL('source-payer-proof.json',import.meta.url),JSON.stringify({captured_at:new Date().toISOString(),scope:'Prospective primitive only; captured financial guard subset, no production/wrapper/UI completeness claim',passed:results.filter(r=>r.pass).length,results},null,2)+'\n');
 console.log(JSON.stringify({passed:results.filter(r=>r.pass).length}));
}finally{await db.end();}
