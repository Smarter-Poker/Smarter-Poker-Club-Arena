import pg from './postgres-runtime/node_modules/pg/lib/index.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
const a=new pg.Client(), b=new pg.Client();
await a.connect(); await b.connect();
try {
 await a.query(input.setup);
 await a.query('BEGIN');
 await b.query('BEGIN');
 const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 await a.query(input.actor);
 await b.query(input.secondActor ?? input.actor);
 const first=(await a.query('SELECT '+input.first+' receipt')).rows[0].receipt;
 if(input.numericReceipt) assert.ok(Number.isFinite(Number(first)));
 else if(input.compositeReceipt) assert.ok(first.id);
 else assert.equal(first.success,true);
 let settled=false;
 const pending=b.query('SELECT '+input.second+' receipt')
  .then(result=>({receipt:result.rows[0].receipt}),error=>({error}))
  .finally(()=>{settled=true;});
 const deadline=Date.now()+5000;
 let waited=false;
 while(Date.now()<deadline&&!settled){
  const state=(await a.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];
  if(state?.wait_event_type==='Lock'){waited=true;break;}
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(waited,true,'Second transaction must contend before the first commits');
 await a.query('COMMIT');
 const second=await pending;
 if(input.receiptError){
  assert.equal(second.receipt?.success,false);
  assert.equal(second.receipt?.error,input.receiptError);
  await b.query('COMMIT');
 } else if(input.conflict){
  assert.equal(second.error?.code,'22023','Conflicting cashout must fail without moving money');
  await b.query('ROLLBACK');
 } else if(input.numericReceipt){
  assert.equal(second.error,undefined);
  assert.equal(second.receipt,first);
  await b.query('COMMIT');
 } else if(input.compositeReceipt){
  assert.equal(second.error,undefined);
  if(input.expectDistinctReceipts) assert.notEqual(second.receipt?.id,first.id);
  else assert.equal(second.receipt?.id,first.id);
  await b.query('COMMIT');
 } else if(input.ticketReceipt){
  assert.equal(second.error,undefined);
  assert.equal(second.receipt?.success,true);
  assert.equal(second.receipt?.replayed,true);
  assert.equal(second.receipt?.transaction_id,first.transaction_id);
  await b.query('COMMIT');
 } else {
  assert.equal(second.receipt?.success,true);
  assert.equal(second.receipt?.replayed,true);
  assert.equal(second.receipt?.cashout_id,first.cashout_id);
  await b.query('COMMIT');
 }
 await a.query(input.verify);
 console.log('fixed: concurrent '+input.name+' passed');
} finally {
 await a.query('ROLLBACK').catch(()=>{});
 await b.query('ROLLBACK').catch(()=>{});
 await a.query(input.cleanup);
 await a.end(); await b.end();
}
